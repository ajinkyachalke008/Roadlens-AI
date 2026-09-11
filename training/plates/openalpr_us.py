"""Fetch the OpenALPR end-to-end benchmark as a held-out plate evaluation set.

This is the only evaluation source in the project that carries real plate
*text*, so it is what a US OCR claim may honestly be measured against. The
upstream repository is AGPL-3.0, the same licence as RoadLens, so using it is
permitted — but the images are photographs of real vehicles, so they are
downloaded on demand into an ignored directory and never committed.

Ground truth lines are `filename<TAB>x<TAB>y<TAB>width<TAB>height<TAB>text`.
"""
import argparse
import csv
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
REPO = 'openalpr/benchmarks'
REF = 'master'
REGIONS = ('us', 'eu', 'br')
LISTING = 'https://api.github.com/repos/{repo}/contents/endtoend/{region}?ref={ref}'
RAW = 'https://raw.githubusercontent.com/{repo}/{ref}/endtoend/{region}/{name}'


def get(url, *, timeout=120):
    request = Request(url, headers={'User-Agent': 'roadlens-plate-eval', 'Accept': 'application/vnd.github+json'})
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def listing(region):
    entries = json.loads(get(LISTING.format(repo=REPO, region=region, ref=REF)))
    if not isinstance(entries, list):
        raise RuntimeError('Unexpected benchmark listing response')
    return sorted(entry['name'] for entry in entries if entry.get('type') == 'file')


def download(region, name, directory):
    target = directory / name
    if target.is_file() and target.stat().st_size > 0:
        return True
    try:
        payload = get(RAW.format(repo=REPO, region=region, ref=REF, name=name))
    except Exception:
        return False
    target.write_bytes(payload)
    return True


def parse_truth(path):
    """One record per annotated plate; an image may legitimately carry several."""
    records = []
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        fields = line.split('\t')
        if len(fields) < 6:
            continue
        try:
            x, y, width, height = (int(float(value)) for value in fields[1:5])
        except ValueError:
            continue
        text = fields[5].strip().upper()
        if width <= 0 or height <= 0 or not text:
            continue
        records.append({'image': fields[0], 'x': x, 'y': y, 'width': width, 'height': height, 'text': text})
    return records


def build(output, region, workers):
    directory = output / region
    directory.mkdir(parents=True, exist_ok=True)
    names = listing(region)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        ok = list(pool.map(lambda name: download(region, name, directory), names))
    unavailable = sum(1 for value in ok if not value)
    rows = []
    for name in sorted(n for n in names if n.endswith('.txt')):
        path = directory / name
        if not path.is_file():
            continue
        for record in parse_truth(path):
            if (directory / record['image']).is_file():
                rows.append(record)
    truth = output / f'{region}-truth.csv'
    with truth.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=['image', 'x', 'y', 'width', 'height', 'text'])
        writer.writeheader()
        writer.writerows(rows)
    manifest = {
        'region': region,
        'source': f'https://github.com/{REPO}/tree/{REF}/endtoend/{region}',
        'license': 'AGPL-3.0',
        'images': len({row['image'] for row in rows}),
        'plates': len(rows),
        'unavailable': unavailable,
        'truth': truth.name,
    }
    (output / f'{region}-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'training/data/plates/openalpr')
    parser.add_argument('--region', default='us', choices=REGIONS)
    parser.add_argument('--workers', type=int, default=12)
    args = parser.parse_args()
    if not 1 <= args.workers <= 32:
        raise SystemExit('Bounds: 1-32 workers')
    print(json.dumps(build(args.output, args.region, args.workers), indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
