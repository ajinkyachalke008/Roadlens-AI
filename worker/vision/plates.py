"""Dedicated plate pipeline: localize, score, rectify, read, normalize.

This is deliberately separate from the traffic detector. YOLO26s is never asked
to know about text; it finds vehicles, and a small single-class model finds the
plate inside a vehicle crop the camera took from its full resolution frame.

Nothing here keeps state between calls. A reading is returned to the camera and
forgotten: the worker holds no plate text, no crop and no history, so consensus
across frames is the camera's job and ends when its session does.
"""
from pathlib import Path
from time import perf_counter
import hashlib
import json
import re

import numpy as np

MODEL_DIR = Path(__file__).resolve().parents[1] / 'models'
PLATE_CATALOG = Path(__file__).resolve().parents[1] / 'plate-catalog.json'
#: Characters a plate reading may contain, matching shared/src/plates.ts.
ALLOWED = re.compile(r'[A-Z0-9]')
TEXT = re.compile(r'^[A-Z0-9][A-Z0-9 -]{0,8}[A-Z0-9]$')
MIN_TEXT, MAX_TEXT = 2, 10
#: Height, in pixels, that plate crops are resized to before OCR. Recognition
#: models are trained around this scale; feeding a 12 px tall crop or a 300 px
#: one both cost accuracy.
OCR_HEIGHT = 64
MAX_OCR_WIDTH = 512
    #: Measured default. On the OpenALPR US set, fast-plate-ocr reads 88.7% of
    #: plates exactly from raw crops and 86.9% after CLAHE: the recognizer does
    #: its own normalization, so adding ours destroys information. RapidOCR is
    #: the opposite (53.6% raw, 59.5% with CLAHE), which is why the variant is
    #: configurable rather than fixed. See docs/PLATE_VALIDATION.md.
PREPROCESSORS = ('none', 'gray', 'clahe', 'sharpen', 'rectify')
DEFAULT_PREPROCESSING = 'none'


def normalize_text(raw):
    """Fold an OCR string to plate characters without inventing any.

    Case and separators are normalised because they are presentation, not
    identity. Ambiguous glyph pairs (0/O, 1/I, 5/S, 8/B) are deliberately left
    alone: substituting them here would turn a guess into an assertion, and the
    only honest evidence for resolving them is agreement across frames.
    """
    if not isinstance(raw, str):
        return None
    text = ''.join(ALLOWED.findall(raw.upper()))
    if not MIN_TEXT <= len(text) <= MAX_TEXT or not TEXT.fullmatch(text):
        return None
    return text


def plausibility(text):
    """How plate-like a candidate string is, independent of OCR confidence.

    A plate crop also contains a state name, a slogan and sometimes a dealer
    frame, and those read cleanly. Length and a mix of letters and digits are
    what actually separate a registration from `CALIFORNIA`.
    """
    if not text:
        return 0.0
    digits = sum(character.isdigit() for character in text)
    letters = len(text) - digits
    score = 1.0
    if not 4 <= len(text) <= 8:
        # Outside the usual North American range, but not impossible.
        score *= 0.55
    if digits == 0 or letters == 0:
        # All letters is usually a slogan; all digits is usually a date or a
        # phone number on a dealer frame. Both happen on real plates, so this
        # is a penalty rather than a rejection.
        score *= 0.6
    return score


def _to_uint8_rgb(image):
    if not isinstance(image, np.ndarray) or image.dtype != np.uint8:
        raise ValueError('Plate crop must be uint8')
    if image.ndim == 2:
        return np.repeat(image[:, :, None], 3, axis=2)
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError('Plate crop must be RGB')
    return image


def sharpness(image):
    """Variance of the Laplacian, the standard blur proxy, on a bounded copy."""
    import cv2
    gray = cv2.cvtColor(_to_uint8_rgb(image), cv2.COLOR_RGB2GRAY)
    if gray.size == 0:
        return 0.0
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _rectify(image):
    """Straighten a slanted plate using its own dominant quadrilateral.

    A plate photographed from the side is a trapezoid, and recognition models
    expect a rectangle. When no convincing quadrilateral is found the original
    crop is returned unchanged — a bad warp is far worse than no warp.
    """
    import cv2
    rgb = _to_uint8_rgb(image)
    height, width = rgb.shape[:2]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(cv2.bilateralFilter(gray, 7, 60, 60), 40, 140)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return rgb
    contour = max(contours, key=cv2.contourArea)
    if cv2.contourArea(contour) < 0.25 * width * height:
        return rgb
    box = cv2.boxPoints(cv2.minAreaRect(contour)).astype(np.float32)
    ordered = np.zeros((4, 2), dtype=np.float32)
    total, diff = box.sum(axis=1), np.diff(box, axis=1).ravel()
    ordered[0], ordered[2] = box[np.argmin(total)], box[np.argmax(total)]
    ordered[1], ordered[3] = box[np.argmin(diff)], box[np.argmax(diff)]
    side = lambda a, b: float(np.linalg.norm(ordered[a] - ordered[b]))
    target_width = int(round(max(side(0, 1), side(3, 2))))
    target_height = int(round(max(side(0, 3), side(1, 2))))
    if target_width < 16 or target_height < 8 or target_width > 4 * width or target_height > 4 * height:
        return rgb
    destination = np.array([[0, 0], [target_width - 1, 0],
                            [target_width - 1, target_height - 1], [0, target_height - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(ordered, destination)
    return cv2.warpPerspective(rgb, matrix, (target_width, target_height), flags=cv2.INTER_CUBIC)


def preprocess_crop(image, variant=DEFAULT_PREPROCESSING):
    """Scale a plate crop to the OCR working height and apply one variant.

    Every variant beyond `none` has to earn its place against held-out data;
    `training/plates/evaluate.py --compare-preprocessing` is what decides which
    one the worker uses, and the answer is recorded in docs/PLATE_VALIDATION.md.
    """
    import cv2
    if variant not in PREPROCESSORS:
        raise ValueError('Unsupported plate preprocessing variant')
    rgb = _to_uint8_rgb(image)
    if variant == 'rectify':
        rgb = _rectify(rgb)
    height, width = rgb.shape[:2]
    if height < 1 or width < 1:
        raise ValueError('Empty plate crop')
    scale = OCR_HEIGHT / height
    target = (min(MAX_OCR_WIDTH, max(8, int(round(width * scale)))), OCR_HEIGHT)
    # Upscaling a small plate is interpolation, never invention: no detail is
    # added, the recognizer simply sees the sampled pixels at its own scale.
    interpolation = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
    rgb = cv2.resize(rgb, target, interpolation=interpolation)
    if variant == 'none':
        return rgb
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    if variant in ('clahe', 'sharpen', 'rectify'):
        gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    if variant == 'sharpen':
        blurred = cv2.GaussianBlur(gray, (0, 0), 1.0)
        gray = cv2.addWeighted(gray, 1.6, blurred, -0.6, 0)
    return np.repeat(gray[:, :, None], 3, axis=2)


def prepare_onnxruntime(device=0):
    """Make ONNX Runtime's CUDA provider actually usable on this machine.

    The same two steps `worker/runtime/onnx_cuda.py` needs: import torch first so
    its bundled CUDA and cuDNN libraries are the ones loaded, and register the
    bundled CUDA provider explicitly, because the 1.29 Windows wheel ships the
    plugin without its auto-register flag. Without this an OCR session silently
    falls back to CPU, or fails on the first convolution.
    """
    import torch  # noqa: F401  (loads the CUDA/cuDNN runtime the EP needs)
    import onnxruntime as ort
    if 'CUDAExecutionProvider' not in ort.get_available_providers():
        return False
    ort.preload_dlls()
    if not any(entry.ep_name == 'CUDAExecutionProvider' for entry in ort.get_ep_devices()):
        from pathlib import Path as _Path
        ort.register_execution_provider_library(
            'CUDAExecutionProvider',
            str(_Path(ort.__file__).parent / 'capi/onnxruntime_providers_cuda.dll'))
    return True


class RapidOcrEngine:
    """PP-OCR text detection and recognition through ONNX Runtime (Apache-2.0).

    A general OCR reads every string in the crop, so the plate has to be chosen
    from among the state name, the slogan and any dealer frame. That choice is
    made on plate plausibility and box geometry, never on reading order.
    """

    name = 'rapidocr'

    def __init__(self, device=0, use_cuda=True):
        from rapidocr import RapidOCR
        use_cuda = use_cuda and prepare_onnxruntime(device)
        params = {
            # Plates are short and often low contrast, so the default text
            # threshold discards readable lines; selection happens afterwards on
            # plate plausibility rather than on raw score.
            'Global.text_score': 0.3,
            'Global.log_level': 'error',
            'EngineConfig.onnxruntime.use_cuda': use_cuda,
            'EngineConfig.onnxruntime.cuda_ep_cfg.device_id': device,
        }
        self.engine = RapidOCR(params=params)

    def read(self, image):
        result = self.engine(image)
        boxes = getattr(result, 'boxes', None)
        texts = getattr(result, 'txts', None) or ()
        scores = getattr(result, 'scores', None) or ()
        candidates = []
        for index, raw in enumerate(texts):
            text = normalize_text(raw)
            if text is None:
                continue
            score = float(scores[index]) if index < len(scores) else 0.0
            width = 1.0
            if boxes is not None and index < len(boxes):
                box = np.asarray(boxes[index], dtype=np.float32)
                width = float(box[:, 0].max() - box[:, 0].min()) or 1.0
            candidates.append((text, max(0.0, min(1.0, score)), width))
        return _select_candidate(candidates)

    def close(self):
        self.engine = None


class FastPlateOcrEngine:
    """Dedicated plate recognizer (MIT) with a fixed plate-character alphabet.

    It reads exactly one plate string per crop, so there is no slogan to reject,
    but it also cannot tell you that the crop held no plate at all.
    """

    name = 'fast-plate-ocr'

    def __init__(self, device=0, use_cuda=True, model='cct-s-v2-global-model'):
        from fast_plate_ocr import LicensePlateRecognizer
        use_cuda = use_cuda and prepare_onnxruntime(device)
        providers = ([('CUDAExecutionProvider', {'device_id': device}), 'CPUExecutionProvider']
                     if use_cuda else ['CPUExecutionProvider'])
        self.model = model
        self.engine = LicensePlateRecognizer(hub_ocr_model=model, providers=providers)

    def read(self, image):
        predictions = self.engine.run(_to_uint8_rgb(image), return_confidence=True)
        if not predictions:
            return None, None
        prediction = predictions[0]
        text = normalize_text(getattr(prediction, 'plate', None))
        if text is None:
            return None, None
        probabilities = getattr(prediction, 'char_probs', None)
        # Per-character probabilities include the padding slots this model always
        # emits; averaging only the slots that produced a kept character keeps the
        # confidence comparable with an engine that reports one score per string.
        if probabilities is None:
            confidence = 0.0
        else:
            kept = np.asarray(probabilities, dtype=np.float64).ravel()[:len(text)]
            confidence = float(kept.mean()) if kept.size else 0.0
        return text, max(0.0, min(1.0, confidence))

    def close(self):
        self.engine = None


def _select_candidate(candidates):
    """Pick the most plate-like reading from a general OCR's several strings."""
    if not candidates:
        return None, None
    widest = max(width for _text, _score, width in candidates)
    best = max(candidates, key=lambda entry: entry[1] * plausibility(entry[0])
               * (0.6 + 0.4 * entry[2] / widest))
    return best[0], best[1]


ENGINES = {'rapidocr': RapidOcrEngine, 'fast-plate-ocr': FastPlateOcrEngine}


def load_ocr(name, device=0, use_cuda=True):
    if name not in ENGINES:
        raise ValueError('Unsupported OCR engine')
    return ENGINES[name](device=device, use_cuda=use_cuda)


class PlateDetector:
    """Single-class `license_plate` localizer, hash pinned like the traffic model."""

    def __init__(self, device=0, catalog=PLATE_CATALOG, model_dir=MODEL_DIR):
        if not catalog.is_file():
            raise RuntimeError('Plate model catalog is not prepared')
        entry = json.loads(catalog.read_text())['detector']
        if not re.fullmatch(r'[A-Za-z0-9_-]+\.pt', entry.get('file', '')):
            raise RuntimeError('Invalid plate artifact filename')
        path = model_dir / entry['file']
        if path.is_symlink() or not path.resolve().is_relative_to(model_dir.resolve()):
            raise RuntimeError('Plate artifact escapes model directory')
        if (not path.is_file() or path.stat().st_size != entry['bytes']
                or hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']):
            raise RuntimeError('Plate model missing or integrity mismatch; run setup-worker.ps1')
        self.model_id = entry['modelId']
        self.model_sha256 = entry['sha256']
        self.input_size = int(entry.get('inputSize', 640))
        self.device = device
        import os
        os.environ['YOLO_CONFIG_DIR'] = str(Path(__file__).resolve().parents[1] / '.config')
        os.environ['YOLO_AUTOINSTALL'] = 'false'
        from ultralytics import YOLO
        self.model = YOLO(str(path))
        names = self.model.names
        if list(names.values()) != ['license_plate']:
            raise RuntimeError('Plate checkpoint is not the expected single class')
        self.model.to(f'cuda:{device}')

    def detect(self, rgb, confidence=0.25):
        """Return plate boxes in the crop, normalised, strongest first."""
        result = self.model.predict(rgb[:, :, ::-1], imgsz=self.input_size, conf=confidence,
                                    device=self.device, verbose=False, max_det=8)[0]
        height, width = rgb.shape[:2]
        boxes = []
        for box in result.boxes:
            x0, y0, x1, y1 = (float(value) for value in box.xyxy[0].tolist())
            if x1 <= x0 or y1 <= y0:
                continue
            boxes.append({
                'box': [max(0.0, x0 / width), max(0.0, y0 / height),
                        min(1.0, x1 / width), min(1.0, y1 / height)],
                'score': float(box.conf[0]),
            })
        return sorted(boxes, key=lambda entry: -entry['score'])

    def close(self):
        self.model = None


class PlateReader:
    """Vehicle crop in, one plate reading out. Holds no state between calls."""

    def __init__(self, detector, ocr, preprocessing=DEFAULT_PREPROCESSING, padding=0.08):
        self.detector = detector
        self.ocr = ocr
        self.preprocessing = preprocessing
        self.padding = padding

    def descriptor(self):
        return {
            'detectorId': self.detector.model_id,
            'detectorSha256': self.detector.model_sha256,
            'ocrEngine': self.ocr.name,
            'inputSize': self.detector.input_size,
        }

    def warmup(self):
        """Run both stages once so the first real request is not the slow one."""
        canvas = np.full((128, 256, 3), 127, dtype=np.uint8)
        self.detector.detect(canvas)
        self.ocr.read(preprocess_crop(canvas, self.preprocessing))
        return True

    def read_jpeg(self, payload, expected_width, expected_height):
        """Decode a bounded vehicle crop and read it. Retains nothing."""
        from worker.vision.preprocess import decode_jpeg
        started = perf_counter()
        rgb = decode_jpeg(payload, expected_width, expected_height)
        decoded = perf_counter()
        reading = self.read(rgb)
        finished = perf_counter()
        timing = reading['timing']
        return {
            **{key: reading[key] for key in
               ('plateText', 'plateConfidence', 'detectorConfidence', 'plateBox')},
            'timing': {
                'decodeMs': (decoded - started) * 1000,
                'detectMs': timing['detectMs'],
                'ocrMs': timing['ocrMs'],
                'totalMs': (finished - started) * 1000,
            },
        }

    def read(self, rgb):
        started = perf_counter()
        boxes = self.detector.detect(rgb)
        detected = perf_counter()
        if not boxes:
            return {
                'plateText': None, 'plateConfidence': None, 'detectorConfidence': None,
                'plateBox': None, 'sharpness': 0.0,
                'timing': {'detectMs': (detected - started) * 1000, 'ocrMs': 0.0},
            }
        best = boxes[0]
        crop = self.crop(rgb, best['box'])
        text, confidence = (None, None)
        if crop.size:
            text, confidence = self.ocr.read(preprocess_crop(crop, self.preprocessing))
        finished = perf_counter()
        return {
            'plateText': text,
            'plateConfidence': confidence if text is not None else None,
            'detectorConfidence': best['score'],
            'plateBox': best['box'],
            'sharpness': sharpness(crop) if crop.size else 0.0,
            'timing': {'detectMs': (detected - started) * 1000, 'ocrMs': (finished - detected) * 1000},
        }

    def crop(self, rgb, box):
        """Pad the plate box slightly; a tight box clips the outer characters."""
        height, width = rgb.shape[:2]
        pad_x = (box[2] - box[0]) * self.padding
        pad_y = (box[3] - box[1]) * self.padding
        x0 = max(0, int((box[0] - pad_x) * width))
        y0 = max(0, int((box[1] - pad_y) * height))
        x1 = min(width, int(round((box[2] + pad_x) * width)))
        y1 = min(height, int(round((box[3] + pad_y) * height)))
        if x1 <= x0 or y1 <= y0:
            return np.empty((0, 0, 3), dtype=np.uint8)
        return rgb[y0:y1, x0:x1]

    def close(self):
        self.detector.close()
        self.ocr.close()
