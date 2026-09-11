"""Fine-tune a single-class `license_plate` localizer for the RoadLens worker.

Transfer learning from the same pinned official YOLO26n checkpoint the traffic
pipeline already verifies, onto the Open Images plate subset built by
`openimages.py`. The split is Open Images' own train/validation/test partition,
so no photograph can appear on both sides of the evaluation.

This model only draws boxes. It is never asked to read text — that is the OCR
engine's job, and keeping the two separate is what lets each be measured, and
replaced, on its own evidence.
"""
import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE_CHECKPOINT = ROOT / 'worker/models/yolo26n.pt'
CATALOG = ROOT / 'worker/model-catalog.json'


def verify_base():
    """The starting weights are the ones the traffic pipeline already pins."""
    import hashlib
    entry = json.loads(CATALOG.read_text())['yolo26n']
    if not BASE_CHECKPOINT.is_file():
        raise SystemExit('Run setup-worker.ps1 once so the official checkpoint is cached')
    if (BASE_CHECKPOINT.stat().st_size != entry['bytes']
            or hashlib.sha256(BASE_CHECKPOINT.read_bytes()).hexdigest() != entry['sha256']):
        raise SystemExit('Cached YOLO26n checkpoint failed its pinned hash')
    return entry


def verify_dataset(data):
    """Refuse to train against a split whose images overlap."""
    import yaml
    config = yaml.safe_load(data.read_text())
    root = Path(config.get('path', data.parent))
    if list(config['names'].values()) != ['license_plate']:
        raise SystemExit('Plate training expects exactly one class named license_plate')
    counts = {}
    seen = {}
    for split in ('train', 'val', 'test'):
        directory = root / config[split]
        names = {path.stem for path in directory.glob('*.jpg')}
        counts[split] = len(names)
        for other, existing in seen.items():
            overlap = names & existing
            if overlap:
                raise SystemExit(f'{len(overlap)} images appear in both {other} and {split}')
        seen[split] = names
    if not counts['train'] or not counts['val']:
        raise SystemExit('Training needs a populated train and val split')
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=ROOT / 'training/data/plates/openimages/plates.yaml')
    parser.add_argument('--epochs', type=int, default=60)
    parser.add_argument('--max-minutes', type=float, default=90)
    parser.add_argument('--batch', type=int, default=16)
    parser.add_argument('--imgsz', type=int, default=640, choices=[640])
    parser.add_argument('--device', type=int, default=0)
    parser.add_argument('--name', default='plate-yolo26n')
    parser.add_argument('--resume', type=Path)
    args = parser.parse_args()
    if not 1 <= args.epochs <= 200 or not 0 < args.max_minutes <= 240 or not 1 <= args.batch <= 64:
        raise SystemExit('Bounds: 1-200 epochs, 0-240 minutes, 1-64 batch')
    base = verify_base()
    counts = verify_dataset(args.data)
    config = dict(data=str(args.data.resolve()), epochs=args.epochs, time=args.max_minutes / 60,
                  batch=args.batch, imgsz=args.imgsz, device=args.device, workers=8, seed=42,
                  deterministic=True, patience=15, project=str(ROOT / 'training/runs/plates'),
                  name=args.name, exist_ok=True, val=True,
                  # A plate is a small, high-aspect object seen at many scales and
                  # angles. Scale and translation matter; heavy colour distortion
                  # and rotation do not reflect how plates actually appear.
                  scale=0.5, translate=0.1, degrees=0.0, shear=0.0, perspective=0.0,
                  fliplr=0.5, flipud=0.0, mosaic=1.0, close_mosaic=10,
                  hsv_h=0.015, hsv_s=0.5, hsv_v=0.3, erasing=0.0)
    print(json.dumps({'base': base['source'], 'splitCounts': counts, 'config': config}, indent=2), flush=True)
    os.environ['YOLO_CONFIG_DIR'] = str(ROOT / 'training/.config')
    os.environ['YOLO_AUTOINSTALL'] = 'false'
    import torch
    if not torch.cuda.is_available():
        raise SystemExit('Plate training requires an available CUDA device')
    from ultralytics import YOLO
    model = YOLO(str(args.resume or BASE_CHECKPOINT))
    # Ultralytics' time budget recomputes `epochs` for itself, so the number the
    # operator asked for has to be enforced independently or the printed config
    # is a fiction. Whichever bound is reached first ends training.
    model.add_callback('on_train_epoch_end',
                       lambda trainer: setattr(trainer, 'stop',
                                               trainer.stop or trainer.epoch + 1 >= args.epochs))
    results = model.train(resume=bool(args.resume), **({} if args.resume else config))
    directory = Path(results.save_dir)
    metrics = model.val(data=str(args.data.resolve()), split='val', imgsz=args.imgsz,
                        device=args.device, verbose=False, plots=False,
                        project=str(ROOT / 'training/runs/plates'), name='val', exist_ok=True)
    summary = {
        'weights': str(directory / 'weights/best.pt'),
        'val': {
            'precision': float(metrics.box.mp),
            'recall': float(metrics.box.mr),
            'mAP50': float(metrics.box.map50),
            'mAP50-95': float(metrics.box.map),
        },
        'splitCounts': counts,
    }
    (directory / 'roadlens-plate-summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary, indent=2), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
