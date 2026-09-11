"""Optional bounded local transfer learning. --execute is explicit opt-in."""
import argparse
import json
import os
from pathlib import Path
from validate_data import validate_yaml

ROOT = Path(__file__).resolve().parents[1]


def validate_resume(checkpoint, data, max_epochs):
    args = checkpoint.get('train_args', {})
    epochs = args.get('epochs')
    epoch = checkpoint.get('epoch')
    if not isinstance(args.get('data'), str) or Path(args['data']).resolve() != data.resolve():
        raise ValueError('Resume checkpoint dataset differs from the validated YAML')
    if type(epochs) is not int or not 1 <= epochs <= max_epochs:
        raise ValueError('Resume checkpoint epochs exceed the requested bound')
    if type(epoch) is not int or not 0 <= epoch < epochs - 1 or checkpoint.get('optimizer') is None:
        raise ValueError('Checkpoint is complete or lacks resumable optimizer state')


def attach_epoch_bound(model, max_epochs):
    # Time mode can recompute args.epochs; retain the user's independent cap.
    def stop_at_bound(trainer):
        trainer.stop = trainer.stop or trainer.epoch + 1 >= max_epochs
    model.add_callback('on_train_epoch_end', stop_at_bound)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--data', type=Path, required=True)
    p.add_argument('--max-minutes', type=float, required=True)
    p.add_argument('--epochs', type=int, default=30)
    p.add_argument('--batch', type=int, default=8)
    p.add_argument('--execute', action='store_true')
    p.add_argument('--resume', type=Path)
    args = p.parse_args()
    if not 0 < args.max_minutes <= 120 or not 1 <= args.epochs <= 30 or not 1 <= args.batch <= 8:
        raise ValueError('Bounds: 0-120 minutes, 1-30 epochs, 1-8 batch')
    validated = validate_yaml(args.data)
    config = dict(data=str(args.data.resolve()), epochs=args.epochs, time=args.max_minutes/60,
                  batch=args.batch, imgsz=640, patience=8, seed=42, deterministic=True,
                  device=0, workers=0, project=str(ROOT/'training/runs'), fliplr=0.5,
                  flipud=0, degrees=0, translate=0.1, scale=0.3, hsv_v=0.2)
    print(json.dumps({'mode': 'EXECUTE' if args.execute else 'DRY_RUN', 'config': config,
                      'splitCounts': validated['counts'], 'resume': str(args.resume) if args.resume else None}, indent=2))
    if not args.execute:
        return
    if args.resume and (args.resume.name != 'last.pt' or not args.resume.is_file()):
        raise ValueError('Resume requires existing trusted local last.pt')
    (ROOT/'training/.config').mkdir(parents=True, exist_ok=True)
    os.environ['YOLO_CONFIG_DIR'] = str(ROOT/'training/.config')
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError('No usable local CUDA; run preflight in a compatible isolated environment')
    from ultralytics import YOLO
    model = YOLO(str(args.resume or ROOT/'training/weights/yolo26n.pt'))
    attach_epoch_bound(model, args.epochs)
    if args.resume:
        validate_resume(model.ckpt, args.data, args.epochs)
        model.train(resume=True, time=args.max_minutes/60, batch=args.batch, workers=0,
                    device=0, imgsz=640, patience=8)
    else:
        model.train(**config)


if __name__ == '__main__':
    main()
