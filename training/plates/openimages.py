"""Build a single-class `license_plate` YOLO dataset from Open Images V7.

Provenance is the whole point of this script. Boxes come from Google's Open
Images V7 `Vehicle registration plate` class (`/m/01jfm_`), whose annotations
are CC BY 4.0; the photographs are the CC BY 2.0 Flickr images distributed by
the Common Visual Data Foundation mirror. Nothing is scraped, and the official
train/validation/test partition is preserved verbatim, so a photograph can
never appear in two splits.

Only annotation CSVs and images are written, always under an ignored directory.
"""
import argparse
import csv
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from time import sleep
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
PLATE_LABEL = '/m/01jfm_'
CLASS_NAME = 'license_plate'
IMAGE_BASE = 'https://open-images-dataset.s3.amazonaws.com'
ANNOTATIONS = {
    'train': 'https://storage.googleapis.com/openimages/v6/oidv6-train-annotations-bbox.csv',
    'validation': 'https://storage.googleapis.com/openimages/v5/validation-annotations-bbox.csv',
    'test': 'https://storage.googleapis.com/openimages/v5/test-annotations-bbox.csv',
}
# Open Images splits map onto YOLO directory names. The partition itself is
# never recomputed: reshuffling it is exactly how leakage gets introduced.
SPLIT_DIR = {'train': 'train', 'validation': 'val', 'test': 'test'}
CLASS_DESCRIPTIONS = 'https://storage.googleapis.com/openimages/v7/oidv7-class-descriptions-boxable.csv'


def fetch(url, destination, *, timeout=60, attempts=40):
    """Resumable, restartable download.

    The train annotation CSV is gigabytes, and long transfers from the public
    mirrors do stall mid-stream, so one blocking read is not a safe way to move
    this much data. Each attempt resumes from the bytes already on disk and
    gives up its socket quickly; steady progress, rather than a single long
    connection, is what lets the build finish.
    """
    if destination.is_file() and destination.stat().st_size > 0:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + '.part')
    for attempt in range(attempts):
        have = partial.stat().st_size if partial.is_file() else 0
        headers = {'User-Agent': 'roadlens-plate-dataset', 'Accept-Encoding': 'identity'}
        if have:
            headers['Range'] = f'bytes={have}-'
        expected = None
        try:
            with urlopen(Request(url, headers=headers), timeout=timeout) as response:
                # Append only when the server actually honoured Range. A mirror
                # that ignores it restarts the object, and appending that would
                # silently corrupt the file.
                resumed = response.status == 206
                length = response.headers.get('Content-Length')
                if length is not None:
                    expected = (have if resumed else 0) + int(length)
                with partial.open('ab' if resumed else 'wb') as handle:
                    while chunk := response.read(1 << 16):
                        handle.write(chunk)
            if expected is None or partial.stat().st_size >= expected:
                partial.replace(destination)
                return destination
        except HTTPError as error:
            # A mirror that does not have this object will never have it; only a
            # rejected range is worth another attempt, from the start.
            if error.code == 416 and partial.is_file():
                partial.unlink()
                continue
            if 400 <= error.code < 500:
                raise
        except (TimeoutError, OSError, ValueError):
            pass
        if not partial.is_file() or partial.stat().st_size <= have:
            # No forward progress at all, so this is a failing mirror rather
            # than a stalled stream; back off before asking again.
            sleep(min(10, 2 ** min(attempt, 3)))
    raise RuntimeError('Open Images download did not complete')


def verify_class(cache):
    """Refuse to build against a label id that is not the published plate class."""
    path = fetch(CLASS_DESCRIPTIONS, cache / 'oidv7-class-descriptions-boxable.csv')
    for row in csv.reader(path.read_text(encoding='utf-8').splitlines()):
        if len(row) == 2 and row[0] == PLATE_LABEL:
            if row[1] != 'Vehicle registration plate':
                raise RuntimeError('Open Images plate label id no longer names the expected class')
            return row[1]
    raise RuntimeError('Open Images class descriptions do not contain the plate label id')


def plate_rows(csv_path):
    """Yield (imageId, box) for genuine individual plate instances only."""
    with csv_path.open('r', encoding='utf-8', newline='') as handle:
        for row in csv.DictReader(handle):
            if row['LabelName'] != PLATE_LABEL:
                continue
            # A group-of box covers a cluster rather than one plate, and a
            # depiction is a picture of a plate rather than a plate. Training a
            # localizer on either teaches the wrong target.
            if row.get('IsGroupOf') == '1' or row.get('IsDepiction') == '1':
                continue
            x0, x1 = float(row['XMin']), float(row['XMax'])
            y0, y1 = float(row['YMin']), float(row['YMax'])
            if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
                continue
            yield row['ImageID'], (x0, y0, x1, y1)


def download_image(image_id, split, directory):
    target = directory / f'{image_id}.jpg'
    if target.is_file() and target.stat().st_size > 0:
        return True
    try:
        fetch(f'{IMAGE_BASE}/{split}/{image_id}.jpg', target, timeout=120)
        return True
    except Exception:
        # A single missing mirror object must not abandon a multi-hour build.
        return False


def build(output, splits, limit, workers):
    cache = output / 'cache'
    cache.mkdir(parents=True, exist_ok=True)
    verify_class(cache)
    manifest = {'class': CLASS_NAME, 'openImagesLabel': PLATE_LABEL, 'splits': {}}
    sources = [('image', 'split', 'openImagesSplit', 'imageId')]
    for split in splits:
        annotations = fetch(ANNOTATIONS[split], cache / f'{split}-annotations-bbox.csv')
        boxes = {}
        for image_id, box in plate_rows(annotations):
            boxes.setdefault(image_id, []).append(box)
        ordered = sorted(boxes)
        if limit:
            ordered = ordered[:limit]
        directory = SPLIT_DIR[split]
        images = output / 'images' / directory
        labels = output / 'labels' / directory
        images.mkdir(parents=True, exist_ok=True)
        labels.mkdir(parents=True, exist_ok=True)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(lambda i: download_image(i, split, images), ordered))
        kept = 0
        instances = 0
        for image_id, ok in zip(ordered, results):
            if not ok:
                continue
            lines = []
            for x0, y0, x1, y1 in boxes[image_id]:
                lines.append(f'0 {(x0 + x1) / 2:.6f} {(y0 + y1) / 2:.6f} {x1 - x0:.6f} {y1 - y0:.6f}')
            (labels / f'{image_id}.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
            sources.append((f'images/{directory}/{image_id}.jpg', directory, split, image_id))
            kept += 1
            instances += len(lines)
        missing = len(ordered) - kept
        manifest['splits'][directory] = {'images': kept, 'instances': instances, 'unavailable': missing}
        print(json.dumps({'split': directory, 'images': kept, 'instances': instances, 'unavailable': missing}), flush=True)
    with (output / 'sources.csv').open('w', encoding='utf-8', newline='') as handle:
        csv.writer(handle).writerows(sources)
    (output / 'plates.yaml').write_text(
        f'path: {output.resolve().as_posix()}\n'
        'train: images/train\nval: images/val\ntest: images/test\n'
        f'names:\n  0: {CLASS_NAME}\n', encoding='utf-8')
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'training/data/plates/openimages')
    parser.add_argument('--splits', nargs='+', default=['train', 'validation', 'test'], choices=list(ANNOTATIONS))
    parser.add_argument('--limit', type=int, default=0, help='Bound images per split; 0 uses every annotated image.')
    parser.add_argument('--workers', type=int, default=16)
    args = parser.parse_args()
    if not 1 <= args.workers <= 32 or args.limit < 0:
        raise SystemExit('Bounds: 1-32 workers, nonnegative limit')
    manifest = build(args.output, args.splits, args.limit, args.workers)
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
