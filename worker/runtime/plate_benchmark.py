"""Measure what plate recognition actually costs the traffic detector.

Three conditions, on the same GPU, in one process, using the same permitted
project photograph the traffic benchmark uses:

  baseline    YOLO26s alone, exactly as a build without plate support runs
  loaded      plate detector and OCR resident in VRAM, but never invoked
  interleaved a plate read submitted between analysis frames, as in production

`loaded` is the condition that matters for the performance gate: plate support
must cost nothing while nothing needs reading. `interleaved` bounds the
temporary cost during an actual event.

Frame bytes exist only for the current call. No plate crop, reading or image is
retained, and no plate text is printed.
"""
import argparse
import hashlib
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path

from worker.runtime.gpu import preflight
from worker.vision.detector import Detector

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'tests/fixtures/bus.jpg'


def summarize(runs):
    total = sorted(run['timing']['totalMs'] for run in runs)
    inference = sorted(run['timing']['inferenceMs'] for run in runs)
    pick = lambda values: values[min(len(values) - 1, int(len(values) * .95))]
    return {
        'frames': len(runs),
        'totalMsMedian': statistics.median(total),
        'totalMsP95': pick(total),
        'inferenceMsMedian': statistics.median(inference),
        'inferenceMsP95': pick(inference),
        'analysisHz': 1000 / statistics.median(total),
    }


PLATE_FIXTURES = ROOT / 'training/data/plates/openalpr/us'


def encode_crop(image):
    """Encode a vehicle crop the way the camera encodes one."""
    from io import BytesIO
    box = image.convert('RGB')
    box.thumbnail((640, 640))
    buffer = BytesIO()
    box.save(buffer, format='JPEG', quality=80)
    return buffer.getvalue(), box.size


def plate_crop(payload, width, height):
    """A vehicle crop to time a plate read against.

    Timing a crop that contains no plate measures detection and silently skips
    OCR, which would understate the cost of a real read. So a photograph from
    the US evaluation set is preferred when it has been downloaded; the project
    fixture is the fallback, and the report says which was used.
    """
    from io import BytesIO
    from PIL import Image
    if PLATE_FIXTURES.is_dir():
        for candidate in sorted(PLATE_FIXTURES.glob('*.jpg'))[:1]:
            with Image.open(candidate) as image:
                image.load()
                crop, size = encode_crop(image.copy())
            return crop, size, 'openalpr-us-sample'
    with Image.open(BytesIO(payload)) as image:
        image.load()
        crop, size = encode_crop(image.crop((0, int(height * .35), width, height)))
    return crop, size, 'project-fixture-no-plate'


def run(iterations=40, warmup=5, model_mode='balanced', runtime='pytorch_cuda',
        ocr_engine='fast-plate-ocr', preprocessing=None, device=0, output=None):
    if not 5 <= iterations <= 200 or not 1 <= warmup <= 20:
        raise ValueError('Benchmark exceeds bounded iteration limits')
    payload = FIXTURE.read_bytes()
    width, height = 810, 1080
    report = {
        'testedAt': datetime.now(timezone.utc).isoformat(),
        'environment': preflight(device),
        'fixture': {
            'path': 'tests/fixtures/bus.jpg',
            'sha256': hashlib.sha256(payload).hexdigest(),
            'limitation': ('One permitted photograph, repeated, on one machine. This measures '
                           'scheduling cost, not field accuracy, motion, phone or network behaviour.'),
        },
        'iterations': iterations,
        'conditions': {},
    }
    detector = Detector(model_mode, runtime, device)
    reader = None
    try:
        detector.warmup(warmup)
        detector.detect_jpeg(payload, width, height)
        report['conditions']['baseline'] = summarize(
            [detector.detect_jpeg(payload, width, height) for _ in range(iterations)])

        from worker.vision.plates import DEFAULT_PREPROCESSING, PlateDetector, PlateReader, load_ocr
        reader = PlateReader(PlateDetector(device=device),
                             load_ocr(ocr_engine, device=device),
                             preprocessing=preprocessing or DEFAULT_PREPROCESSING)
        reader.warmup()
        crop, (crop_width, crop_height), crop_source = plate_crop(payload, width, height)
        # Resident but idle: the condition the performance gate is about.
        report['conditions']['loaded'] = summarize(
            [detector.detect_jpeg(payload, width, height) for _ in range(iterations)])

        interleaved = []
        plate_times = []
        for index in range(iterations):
            frame = detector.detect_jpeg(payload, width, height)
            interleaved.append(frame)
            # The worker only ever admits a plate task between analysis frames,
            # so that is exactly how it is measured here.
            if index % 4 == 0:
                reading = reader.read_jpeg(crop, crop_width, crop_height)
                plate_times.append(reading['timing'])
        report['conditions']['interleaved'] = summarize(interleaved)
        report['plate'] = {
            'reads': len(plate_times),
            'cropSource': crop_source,
            # A crop with no plate in it never reaches the recognizer, so the
            # measurement would be detection only. Say so rather than imply a
            # full read was timed.
            'ocrRan': any(timing['ocrMs'] > 0 for timing in plate_times),
            'engine': reader.ocr.name,
            'detectorId': reader.detector.model_id,
            'preprocessing': reader.preprocessing,
            'totalMsMedian': statistics.median(t['totalMs'] for t in plate_times),
            'totalMsP95': sorted(t['totalMs'] for t in plate_times)[
                min(len(plate_times) - 1, int(len(plate_times) * .95))],
            'detectMsMedian': statistics.median(t['detectMs'] for t in plate_times),
            'ocrMsMedian': statistics.median(t['ocrMs'] for t in plate_times),
        }
        baseline = report['conditions']['baseline']['analysisHz']
        for name in ('loaded', 'interleaved'):
            condition = report['conditions'][name]
            condition['analysisHzDeltaPercent'] = (condition['analysisHz'] - baseline) / baseline * 100
    finally:
        if reader:
            reader.close()
        detector.close()
    for name, condition in report['conditions'].items():
        delta = condition.get('analysisHzDeltaPercent')
        print(f'{name:12} {condition["analysisHz"]:6.2f} Hz  total {condition["totalMsMedian"]:6.2f} ms'
              + (f'  {delta:+.1f}%' if delta is not None else '  (reference)'), flush=True)
    if 'plate' in report:
        print(f'plate read   {report["plate"]["totalMsMedian"]:6.2f} ms median '
              f'({report["plate"]["detectMsMedian"]:.2f} detect + {report["plate"]["ocrMsMedian"]:.2f} OCR) '
              f'[{report["plate"]["cropSource"]}'
              + ('' if report['plate']['ocrRan'] else ', no plate found: detection only')
              + ']', flush=True)
    if output:
        output = Path(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iterations', type=int, default=40)
    parser.add_argument('--warmup', type=int, default=5)
    parser.add_argument('--model-mode', default='balanced', choices=['fast', 'balanced', 'quality'])
    parser.add_argument('--runtime', default='pytorch_cuda', choices=['pytorch_cuda', 'onnx_cuda', 'tensorrt'])
    parser.add_argument('--ocr', default='fast-plate-ocr')
    parser.add_argument('--preprocess')
    parser.add_argument('--device', type=int, default=0)
    parser.add_argument('--output', type=Path, default=Path('docs/evidence/plate-impact.json'))
    args = parser.parse_args()
    run(args.iterations, args.warmup, args.model_mode, args.runtime, args.ocr,
        args.preprocess, args.device, args.output)


if __name__ == '__main__':
    main()
