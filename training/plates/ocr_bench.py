"""Measure candidate OCR engines on ground-truth US plate crops.

Engine selection is decided here, on held-out data, rather than by reputation.
Crops come from the OpenALPR end-to-end benchmark's own plate boxes, so this
isolates recognition quality from localization quality: a detector mistake
cannot flatter or penalise an engine.

Reported per engine and preprocessing variant:

  exact      fraction of plates whose full string matched
  character  1 - mean normalised edit distance, so a one-glyph miss is visible
  coverage   fraction that produced any reading at all
  msMean/p95 latency of the recognition call
"""
import argparse
import csv
import json
import sys
from pathlib import Path
from time import perf_counter

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from worker.vision.plates import (  # noqa: E402
    ENGINES,
    PREPROCESSORS,
    load_ocr,
    normalize_text,
    preprocess_crop,
)


def edit_distance(a, b):
    if a == b:
        return 0
    if not a or not b:
        return max(len(a), len(b))
    previous = list(range(len(b) + 1))
    for i, left in enumerate(a, 1):
        current = [i]
        for j, right in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1,
                               previous[j - 1] + (left != right)))
        previous = current
    return previous[-1]


def character_accuracy(truth, guess):
    if not truth:
        return 0.0
    return max(0.0, 1 - edit_distance(truth, guess or '') / len(truth))


def load_samples(directory, region, padding):
    """Crop each annotated plate, padded, straight from the benchmark photo."""
    import cv2
    truth_path = directory / f'{region}-truth.csv'
    if not truth_path.is_file():
        raise SystemExit(f'Run openalpr_us.py --region {region} first')
    samples = []
    with truth_path.open('r', encoding='utf-8', newline='') as handle:
        for row in csv.DictReader(handle):
            image_path = directory / region / row['image']
            if not image_path.is_file():
                continue
            bgr = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
            if bgr is None:
                continue
            height, width = bgr.shape[:2]
            x, y = int(row['x']), int(row['y'])
            box_width, box_height = int(row['width']), int(row['height'])
            pad_x, pad_y = int(box_width * padding), int(box_height * padding)
            x0, y0 = max(0, x - pad_x), max(0, y - pad_y)
            x1, y1 = min(width, x + box_width + pad_x), min(height, y + box_height + pad_y)
            if x1 <= x0 or y1 <= y0:
                continue
            text = normalize_text(row['text'])
            if text is None:
                continue
            samples.append((text, bgr[y0:y1, x0:x1][:, :, ::-1].copy()))
    return samples


def measure(engine, samples, variant):
    exact = 0
    characters = []
    read = 0
    latencies = []
    for truth, crop in samples:
        prepared = preprocess_crop(crop, variant)
        started = perf_counter()
        text, _confidence = engine.read(prepared)
        latencies.append((perf_counter() - started) * 1000)
        if text:
            read += 1
        if text == truth:
            exact += 1
        characters.append(character_accuracy(truth, text))
    total = len(samples) or 1
    return {
        'variant': variant,
        'samples': len(samples),
        'exact': exact / total,
        'character': float(np.mean(characters)) if characters else 0.0,
        'coverage': read / total,
        'msMean': float(np.mean(latencies)) if latencies else 0.0,
        'msP95': float(np.percentile(latencies, 95)) if latencies else 0.0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=ROOT / 'training/data/plates/openalpr')
    parser.add_argument('--region', default='us')
    parser.add_argument('--engines', nargs='+', default=list(ENGINES), choices=list(ENGINES))
    parser.add_argument('--variants', nargs='+', default=list(PREPROCESSORS), choices=list(PREPROCESSORS))
    parser.add_argument('--padding', type=float, default=0.08)
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--cpu', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    samples = load_samples(args.data, args.region, args.padding)
    if args.limit:
        samples = samples[:args.limit]
    if not samples:
        raise SystemExit('No annotated plate crops available')
    results = []
    for name in args.engines:
        engine = load_ocr(name, use_cuda=not args.cpu)
        try:
            # One untimed pass so session/graph warmup is not charged to the
            # first variant, which would make engine comparison meaningless.
            engine.read(preprocess_crop(samples[0][1], args.variants[0]))
            for variant in args.variants:
                measurement = measure(engine, samples, variant)
                measurement['engine'] = name
                results.append(measurement)
                print(json.dumps(measurement), flush=True)
        finally:
            engine.close()
    report = {
        'region': args.region,
        'samples': len(samples),
        'padding': args.padding,
        'device': 'cpu' if args.cpu else 'cuda',
        'results': sorted(results, key=lambda entry: -entry['exact']),
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report['results'][:3], indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
