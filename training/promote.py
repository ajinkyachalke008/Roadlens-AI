"""Promote a staged, hash-verified profile after supplied browser and phone evidence."""
import argparse
import hashlib
import json
import re
import shutil
import tempfile
from pathlib import Path
from validate_data import NAMES

ROOT = Path(__file__).resolve().parents[1]


def safe_name(value, suffix=''):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}' + re.escape(suffix), value):
        raise ValueError('Unsafe artifact filename or model id')
    return value


def contained(path, parent):
    if not path.resolve().is_relative_to(parent.resolve()) or path.is_symlink():
        raise ValueError('Artifact path escapes its intended directory')
    return path


def plan_promotion(manifest_path, validation_path, tradeoff, root=ROOT):
    manifest_path = manifest_path.resolve(strict=True)
    m = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
    v = json.loads(validation_path.read_text(encoding='utf-8-sig'))
    safe_name(m.get('id')); safe_name(m.get('file'), '.onnx')
    model = contained(manifest_path.parent/m['file'], manifest_path.parent)
    if not model.is_file() or not 1000 <= model.stat().st_size <= 32*1024*1024:
        raise ValueError('Model exceeds release artifact size bounds')
    digest = hashlib.sha256(model.read_bytes()).hexdigest()
    if digest != m.get('sha256') or model.stat().st_size != m.get('bytes'):
        raise ValueError('Artifact integrity mismatch')
    if v.get('modelSha256') != digest or v.get('browserParity') != 'PASS' or v.get('physicalPhoneBenchmark') != 'PASS' or not isinstance(v.get('measurements'), (dict, list)) or not v['measurements']:
        raise ValueError('Promotion requires matching actual browser parity and physical phone benchmark evidence')
    profile = m.get('profile')
    expected_input = dict(name='images', shape=[1, 3, profile, profile], dtype='float32', color='RGB', layout='NCHW', normalization='divide_255')
    if profile not in (416, 320) or m.get('input') != expected_input:
        raise ValueError('Unsupported release input')
    # The current build verification and reference suite only promote this inspected head.
    if m.get('output') != dict(name='output0', shape=[1, 300, 6], dtype='float32', format='yolo_e2e_xyxy_score_class'):
        raise ValueError('Unsupported release decoder; raw-head promotion is not verified')
    if m.get('decoderVersion') != 'roadlens_decode_v1' or m.get('letterbox') != dict(padding=114, rounding='half_up', resize='pixel_center_bilinear_no_antialias', extraPadding='bottom_right'):
        raise ValueError('Unsupported preprocessing semantics')
    class_map = m.get('classMap', {})
    count = m.get('classCount')
    if type(count) is not int or not 6 <= count <= 100 or not isinstance(class_map, dict) or set(class_map.values()) != set(NAMES) or any(not re.fullmatch(r'0|[1-9][0-9]*', k) or int(k) >= count for k in class_map):
        raise ValueError('Incorrect semantic mapping')
    confidence = m.get('confidence', {})
    values = [confidence.get(k) for k in ('low', 'high', 'newTrack')]
    if not all(type(x) in (int, float) and 0 <= x <= 1 for x in values) or values != sorted(values):
        raise ValueError('Invalid confidence policy')
    runtime = json.loads((root/'package.json').read_text())['dependencies']['onnxruntime-web']
    if m.get('runtimeVersion') != runtime:
        raise ValueError('Runtime version differs from the locked release')
    public = contained(root/'frontend/public/models', root)
    if manifest_path.is_relative_to(public.resolve()):
        raise ValueError('Promotion source must be staged outside public assets')
    # This release carries Ultralytics-derived checkpoints; preserve its existing notice.
    notice = contained(public/'ULTRALYTICS-LICENSE.txt', public)
    if m.get('license') != 'AGPL-3.0' or not m.get('source') or not notice.is_file():
        raise ValueError('Release license/provenance requires preserved Ultralytics AGPL notice')
    if not tradeoff.strip():
        raise ValueError('Document measured tradeoff')
    target_manifest = contained(public/f'yolo26n-{profile}.json', public)
    target_model = contained(public/m['file'], public)
    backups = []
    if target_manifest.exists():
        old = json.loads(target_manifest.read_text())
        old_model = contained(public/safe_name(old.get('file'), '.onnx'), public)
        backups += [target_manifest, old_model]
    if target_model.exists() and target_model not in backups:
        raise ValueError('Target model filename already belongs to another artifact')
    rollback = contained(root/'training/rollback', root)
    return dict(manifest=manifest_path, model=model, public=public, target_manifest=target_manifest,
                target_model=target_model, backups=backups, rollback=rollback, id=m['id'], tradeoff=tradeoff)


def execute_promotion(plan):
    plan['rollback'].mkdir(parents=True, exist_ok=True)
    rollback = Path(tempfile.mkdtemp(prefix=plan['id']+'-', dir=plan['rollback']))
    for path in plan['backups']:
        shutil.copy2(path, rollback/path.name)
    (rollback/'promotion.json').write_text(json.dumps({'model': plan['id'], 'tradeoff': plan['tradeoff']}, indent=2)+'\n')
    shutil.copy2(plan['model'], plan['target_model'])
    shutil.copy2(plan['manifest'], plan['target_manifest'])
    return rollback


def main():
    p = argparse.ArgumentParser()
    p.add_argument('manifest', type=Path)
    p.add_argument('--validation', type=Path, required=True)
    p.add_argument('--accept-tradeoff', required=True)
    p.add_argument('--execute', action='store_true')
    args = p.parse_args()
    plan = plan_promotion(args.manifest, args.validation, args.accept_tradeoff)
    print(json.dumps({'mode': 'EXECUTE' if args.execute else 'DRY_RUN', 'model': plan['id'], 'tradeoff': plan['tradeoff']}, indent=2))
    if args.execute:
        execute_promotion(plan)


if __name__ == '__main__':
    main()
