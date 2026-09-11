"""Install a trained plate detector into the worker's hash-pinned model store.

The worker refuses to load any plate artifact whose bytes do not match
`worker/plate-catalog.json`, for the same reason the traffic detector does: a
model file is executable input, and "the file that happens to be there" is not a
provenance record. This tool is what writes that record, and it will not write
one for a checkpoint it could not open and check.
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / 'worker/models'
CATALOG = ROOT / 'worker/plate-catalog.json'


def inspect(checkpoint, device):
    """Open the checkpoint and confirm it really is a single-class localizer."""
    os.environ['YOLO_CONFIG_DIR'] = str(ROOT / 'training/.config')
    os.environ['YOLO_AUTOINSTALL'] = 'false'
    from ultralytics import YOLO
    model = YOLO(str(checkpoint))
    names = list(model.names.values())
    if names != ['license_plate']:
        raise SystemExit(f'Expected a single license_plate class, found {names}')
    import torch
    if torch.cuda.is_available():
        model.to(f'cuda:{device}')
    return names


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--model-id', default='plate-yolo26n-640-v1')
    parser.add_argument('--input-size', type=int, default=640)
    parser.add_argument('--device', type=int, default=0)
    parser.add_argument('--license', default='AGPL-3.0')
    parser.add_argument('--training-data', default='Open Images V7 "Vehicle registration plate" (/m/01jfm_)')
    parser.add_argument('--base', default='Ultralytics YOLO26n (AGPL-3.0)')
    parser.add_argument('--metrics', type=Path, help='Optional summary JSON written by train_plate.py.')
    args = parser.parse_args()
    if not args.checkpoint.is_file():
        raise SystemExit('Checkpoint not found')
    if not 128 <= args.input_size <= 1280:
        raise SystemExit('Input size must be between 128 and 1280')
    if not args.model_id.replace('-', '').replace('_', '').isalnum():
        raise SystemExit('Model id must be a plain identifier')
    inspect(args.checkpoint, args.device)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    target = MODEL_DIR / f'{args.model_id}.pt'
    shutil.copyfile(args.checkpoint, target)
    payload = target.read_bytes()
    entry = {
        'file': target.name,
        'modelId': args.model_id,
        'bytes': len(payload),
        'sha256': hashlib.sha256(payload).hexdigest(),
        'inputSize': args.input_size,
        'classes': ['license_plate'],
        'license': args.license,
        'base': args.base,
        'trainingData': args.training_data,
    }
    if args.metrics and args.metrics.is_file():
        entry['metrics'] = json.loads(args.metrics.read_text()).get('val')
    CATALOG.write_text(json.dumps({'detector': entry}, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'catalog': str(CATALOG), 'detector': entry}, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
