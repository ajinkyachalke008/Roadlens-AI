"""Reproducible plate evaluation, kept honest about which domain it measured.

Three things are measured, and they are reported separately because they fail
separately:

  detector     precision, recall and mAP for plate localization
  end-to-end   exact plate string and character accuracy, detector included
  ocr-only     the same accuracy from ground-truth boxes, isolating recognition

`--domain` names what the numbers describe. A global localization set says
nothing about US plate *text*, and this tool will not let a report pretend
otherwise: the domain travels with every result it writes.

The operator's own consented images are a first-class domain here. Drop images
and a `truth.csv` into `training/data/plates/user_eval/` and run
`--suite user`; no code changes are needed, and nothing under that directory is
ever committed.
"""
import argparse
import csv
import json
import os
import sys
from pathlib import Path
from time import perf_counter

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from worker.vision.plates import (  # noqa: E402
    DEFAULT_PREPROCESSING,
    PREPROCESSORS,
    PlateDetector,
    PlateReader,
    load_ocr,
    normalize_text,
    preprocess_crop,
)
from training.plates.ocr_bench import character_accuracy  # noqa: E402

#: Plate width in source pixels. Aggregate mAP hides exactly the bucket that
#: matters most in traffic footage, so it is always broken out.
SIZE_BUCKETS = ((0, 24), (24, 48), (48, 96), (96, 10_000))


def iou(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    overlap = (x1 - x0) * (y1 - y0)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return overlap / (area_a + area_b - overlap)


def bucket(width):
    for low, high in SIZE_BUCKETS:
        if low <= width < high:
            return f'{low}-{high if high < 10_000 else "inf"}px'
    return 'unknown'


def load_truth(directory, region=None):
    """Ground truth as `image -> [ {box, text} ]`, from either supported layout."""
    path = directory / (f'{region}-truth.csv' if region else 'truth.csv')
    if not path.is_file():
        raise SystemExit(f'Expected ground truth at {path}')
    images = directory / region if region else directory
    truth = {}
    with path.open('r', encoding='utf-8', newline='') as handle:
        for row in csv.DictReader(handle):
            name = row['image']
            if not (images / name).is_file():
                continue
            text = normalize_text(row.get('text', ''))
            box = None
            if all(row.get(key) not in (None, '') for key in ('x', 'y', 'width', 'height')):
                x, y = float(row['x']), float(row['y'])
                box = [x, y, x + float(row['width']), y + float(row['height'])]
            truth.setdefault(name, []).append({'box': box, 'text': text})
    if not truth:
        raise SystemExit(f'No usable ground-truth rows in {path}')
    return images, truth


def evaluate_scene(reader, images, truth, confidence, suite):
    """Run the shipped pipeline over whole photographs, exactly as the worker does."""
    import cv2
    matched = 0
    predicted = 0
    expected = 0
    exact = 0
    characters = []
    readable = 0
    by_bucket = {}
    latencies = []
    names = sorted(truth)
    # One untimed pass first: the first image pays CUDA graph and session warmup,
    # and charging that to the reported latency would misdescribe steady state.
    if names:
        warm = cv2.imread(str(images / names[0]), cv2.IMREAD_COLOR)
        if warm is not None:
            reader.read(warm[:, :, ::-1].copy())
    for name in names:
        bgr = cv2.imread(str(images / name), cv2.IMREAD_COLOR)
        if bgr is None:
            continue
        rgb = bgr[:, :, ::-1].copy()
        height, width = rgb.shape[:2]
        started = perf_counter()
        boxes = reader.detector.detect(rgb, confidence=confidence)
        entries = truth[name]
        expected += len(entries)
        predicted += len(boxes)
        pixel_boxes = [
            [entry['box'][0], entry['box'][1], entry['box'][2], entry['box'][3]]
            for entry in entries
            if entry['box'] is not None
        ]
        used = set()
        for detection in boxes:
            box = [detection['box'][0] * width, detection['box'][1] * height,
                   detection['box'][2] * width, detection['box'][3] * height]
            best, best_index = 0.0, None
            for index, target in enumerate(pixel_boxes):
                if index in used:
                    continue
                score = iou(box, target)
                if score > best:
                    best, best_index = score, index
            if best >= 0.5 and best_index is not None:
                used.add(best_index)
                matched += 1
        for index, target in enumerate(pixel_boxes):
            key = bucket(target[2] - target[0])
            stats = by_bucket.setdefault(key, {'expected': 0, 'matched': 0})
            stats['expected'] += 1
            stats['matched'] += int(index in used)
        # End-to-end reading, from the detection pass already made above: the
        # pipeline picks its own best box, exactly as the worker does. Detecting
        # a second time here would both waste GPU and inflate the latency this
        # function reports.
        guess = None
        if boxes:
            plate = reader.crop(rgb, boxes[0]['box'])
            if plate.size:
                guess, _confidence = reader.ocr.read(
                    preprocess_crop(plate, reader.preprocessing))
        latencies.append((perf_counter() - started) * 1000)
        target_text = next((entry['text'] for entry in entries if entry['text']), None)
        if target_text is None:
            continue
        if guess:
            readable += 1
        if guess == target_text:
            exact += 1
        characters.append(character_accuracy(target_text, guess))
    labelled = max(1, len(characters))
    return {
        'suite': suite,
        'images': len(truth),
        'plates': expected,
        'detector': {
            'precision': matched / predicted if predicted else 0.0,
            'recall': matched / expected if expected else 0.0,
            'confidence': confidence,
            'iouThreshold': 0.5,
            'bySize': {
                key: {**value, 'recall': value['matched'] / value['expected'] if value['expected'] else 0.0}
                for key, value in sorted(by_bucket.items())
            },
        },
        'endToEnd': {
            'exact': exact / labelled,
            'character': float(np.mean(characters)) if characters else 0.0,
            'coverage': readable / labelled,
            'labelled': len(characters),
        },
        'latencyMs': {
            'median': float(np.median(latencies)) if latencies else 0.0,
            'mean': float(np.mean(latencies)) if latencies else 0.0,
            'p95': float(np.percentile(latencies, 95)) if latencies else 0.0,
        },
    }


def evaluate_split(data, weights, device, imgsz):
    """Ultralytics' own mAP over a held-out YOLO split."""
    os.environ['YOLO_CONFIG_DIR'] = str(ROOT / 'training/.config')
    os.environ['YOLO_AUTOINSTALL'] = 'false'
    from ultralytics import YOLO
    # Keep Ultralytics' run artifacts inside the ignored training tree rather
    # than letting it create a `runs/` directory at the repository root.
    metrics = YOLO(str(weights)).val(data=str(data), split='test', imgsz=imgsz,
                                     device=device, verbose=False, plots=False,
                                     project=str(ROOT / 'training/runs/plates'),
                                     name='eval', exist_ok=True)
    return {
        'precision': float(metrics.box.mp),
        'recall': float(metrics.box.mr),
        'mAP50': float(metrics.box.map50),
        'mAP50-95': float(metrics.box.map),
    }


def evaluate_preprocessing(reader, images, truth, variants):
    """Recognition only, from ground-truth boxes, one row per variant."""
    import cv2
    crops = []
    for name in sorted(truth):
        bgr = cv2.imread(str(images / name), cv2.IMREAD_COLOR)
        if bgr is None:
            continue
        height, width = bgr.shape[:2]
        for entry in truth[name]:
            if entry['box'] is None or not entry['text']:
                continue
            x0, y0, x1, y1 = (int(round(value)) for value in entry['box'])
            x0, y0 = max(0, x0), max(0, y0)
            x1, y1 = min(width, x1), min(height, y1)
            if x1 <= x0 or y1 <= y0:
                continue
            crops.append((entry['text'], bgr[y0:y1, x0:x1][:, :, ::-1].copy()))
    rows = []
    for variant in variants:
        exact = 0
        characters = []
        for text, crop in crops:
            guess, _confidence = reader.ocr.read(preprocess_crop(crop, variant))
            exact += int(guess == text)
            characters.append(character_accuracy(text, guess))
        rows.append({
            'variant': variant,
            'exact': exact / max(1, len(crops)),
            'character': float(np.mean(characters)) if characters else 0.0,
            'crops': len(crops),
        })
    return sorted(rows, key=lambda row: -row['exact'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', default='us', choices=['us', 'eu', 'br', 'openimages', 'user'])
    parser.add_argument('--domain', help='Human name for what these numbers describe.')
    parser.add_argument('--data', type=Path, default=ROOT / 'training/data/plates')
    parser.add_argument('--weights', type=Path, help='Defaults to the catalogued worker detector.')
    parser.add_argument('--ocr', default='fast-plate-ocr')
    parser.add_argument('--preprocess', default=DEFAULT_PREPROCESSING, choices=list(PREPROCESSORS))
    parser.add_argument('--compare-preprocessing', action='store_true')
    parser.add_argument('--confidence', type=float, default=0.25)
    parser.add_argument('--device', type=int, default=0)
    parser.add_argument('--imgsz', type=int, default=640)
    parser.add_argument('--cpu', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    detector = PlateDetector(device=args.device)
    reader = PlateReader(detector, load_ocr(args.ocr, device=args.device, use_cuda=not args.cpu),
                         preprocessing=args.preprocess)
    report = {
        'suite': args.suite,
        # Never let a number escape without saying what it describes.
        'domain': args.domain or {
            'us': 'OpenALPR end-to-end benchmark, United States plates',
            'eu': 'OpenALPR end-to-end benchmark, European plates',
            'br': 'OpenALPR end-to-end benchmark, Brazilian plates',
            'openimages': 'Open Images V7 plate localization, global, no text labels',
            'user': 'Operator-supplied consented images',
        }[args.suite],
        'detectorModel': detector.model_id,
        'detectorSha256': detector.model_sha256,
        'ocrEngine': reader.ocr.name,
        'preprocessing': args.preprocess,
    }
    try:
        if args.suite == 'openimages':
            report['localization'] = evaluate_split(
                args.data / 'openimages/plates.yaml',
                args.weights or (ROOT / 'worker/models' / f'{detector.model_id}.pt'),
                args.device, args.imgsz)
            report['note'] = ('Localization only. This set carries no plate text, so it '
                              'cannot support any OCR accuracy claim.')
        else:
            region = None if args.suite == 'user' else args.suite
            directory = args.data / ('user_eval' if args.suite == 'user' else 'openalpr')
            images, truth = load_truth(directory, region)
            report.update(evaluate_scene(reader, images, truth, args.confidence, args.suite))
            if args.compare_preprocessing:
                report['preprocessingComparison'] = evaluate_preprocessing(
                    reader, images, truth, list(PREPROCESSORS))
    finally:
        reader.close()
    text = json.dumps(report, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + '\n', encoding='utf-8')
    print(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
