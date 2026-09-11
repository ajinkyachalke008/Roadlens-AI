"""Synthetic safety regressions only: no training or accuracy claims."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import yaml
from train import attach_epoch_bound, validate_resume
from validate_data import NAMES, validate_yaml
from promote import execute_promotion, plan_promotion


class YamlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root/'traffic.yaml'
        self.data = dict(names=NAMES, train='images/train', val='images/val', test='images/test')
    def tearDown(self):
        self.tmp.cleanup()
    def check(self):
        self.path.write_text(yaml.safe_dump(self.data))
        with patch('validate_data.validate', return_value={'validated': True}) as validate:
            result = validate_yaml(self.path)
            validate.assert_called_once_with(self.root.resolve())
            return result
    def test_exact_tree_and_absolute_root(self):
        self.assertTrue(self.check()['validated'])
        self.data['path'] = str(self.root)
        self.assertTrue(self.check()['validated'])
    def test_rejects_other_or_relative_root(self):
        for path in ('.', str(self.root/'other')):
            with self.subTest(path=path):
                self.data['path'] = path
                with self.assertRaisesRegex(ValueError, 'absolute YAML'): self.check()
    def test_rejects_download_and_external_splits(self):
        self.data['download'] = 'echo unsafe'
        with self.assertRaisesRegex(ValueError, 'download'): self.check()
        del self.data['download']
        for value in ('../other/train', ['images/train'], '/remote/train'):
            self.data['train'] = value
            with self.assertRaisesRegex(ValueError, 'splits'): self.check()
    def test_class_order_and_unvalidated_extra_split(self):
        self.data['names'] = dict(enumerate(NAMES[::-1]))
        with self.assertRaisesRegex(ValueError, 'semantic'): self.check()
        self.data['names'] = NAMES
        self.data['minival'] = 'somewhere'
        with self.assertRaisesRegex(ValueError, 'minival'): self.check()


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.path = Path('approved/traffic.yaml').resolve()
        self.ckpt = dict(train_args=dict(data=str(self.path), epochs=10), epoch=4, optimizer={})
    def test_valid_resume(self):
        validate_resume(self.ckpt, self.path, 10)
    def test_resume_other_data_and_epoch_overrun(self):
        with self.assertRaisesRegex(ValueError, 'dataset'): validate_resume(self.ckpt, self.path.parent/'other.yaml', 10)
        with self.assertRaisesRegex(ValueError, 'epochs'): validate_resume(self.ckpt, self.path, 5)
    def test_rejects_finished_or_stripped_checkpoints(self):
        for change in ({'epoch': 9}, {'epoch': -1}, {'optimizer': None}):
            with self.subTest(change=change):
                with self.assertRaisesRegex(ValueError, 'resumable'): validate_resume(self.ckpt | change, self.path, 10)
    def test_epoch_cap_survives_dynamic_time_epochs(self):
        callbacks = {}
        attach_epoch_bound(SimpleNamespace(add_callback=lambda name, fn: callbacks.update({name: fn})), 10)
        fn = callbacks['on_train_epoch_end']
        trainer = SimpleNamespace(epoch=8, epochs=1000, stop=False)
        fn(trainer); self.assertFalse(trainer.stop)
        trainer.epoch = 9
        fn(trainer); self.assertTrue(trainer.stop)
        trainer.epoch = 0
        fn(trainer); self.assertTrue(trainer.stop)


class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.public = self.root/'frontend/public/models'; self.public.mkdir(parents=True)
        self.staged = self.root/'training/staging'; self.staged.mkdir(parents=True)
        (self.root/'package.json').write_text(json.dumps({'dependencies': {'onnxruntime-web': '1.29.0'}}))
        (self.public/'ULTRALYTICS-LICENSE.txt').write_text('Test-only notice placeholder')
        # Copy schema, but use synthetic bytes: this checks promotion safeguards, not inference.
        self.m = json.loads((Path(__file__).resolve().parents[1]/'frontend/public/models/yolo26n-416.json').read_text())
        self.m.update(id='synthetic-unit', file='synthetic-unit.onnx', bytes=1000, sha256=hashlib.sha256(b'x'*1000).hexdigest())
        (self.staged/self.m['file']).write_bytes(b'x'*1000)
        self.manifest = self.staged/'model.json'; self.validation = self.staged/'evidence.json'
        self.v = dict(modelSha256=self.m['sha256'], browserParity='PASS', physicalPhoneBenchmark='PASS', measurements={'synthetic_test_only': True})
    def tearDown(self): self.tmp.cleanup()
    def plan(self):
        self.manifest.write_text(json.dumps(self.m)); self.validation.write_text(json.dumps(self.v))
        return plan_promotion(self.manifest, self.validation, 'Synthetic safety test only', self.root)
    def test_valid_plan_is_read_only_and_execution_preserves_previous(self):
        old = copy.deepcopy(self.m); old['file'] = 'old.onnx'
        (self.public/'old.onnx').write_bytes(b'old')
        (self.public/'yolo26n-416.json').write_text(json.dumps(old))
        plan = self.plan()
        self.assertFalse(plan['target_model'].exists())
        rollback = execute_promotion(plan)
        self.assertEqual((rollback/'old.onnx').read_bytes(), b'old')
        self.assertEqual(plan['target_model'].read_bytes(), b'x'*1000)
    def test_rejects_path_traversal_absolute_and_backslashes(self):
        for value in ('../escaped.onnx', '/escaped.onnx', 'C:\\escaped.onnx', '..\\escaped.onnx'):
            self.m['file'] = value
            with self.assertRaisesRegex(ValueError, 'Unsafe'): self.plan()
    def test_rejects_unsafe_id(self):
        self.m['id'] = '../rollback'
        with self.assertRaisesRegex(ValueError, 'Unsafe'): self.plan()
    def test_rejects_hash_or_evidence_mismatch(self):
        self.v['modelSha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'evidence'): self.plan()
        self.v['modelSha256'] = self.m['sha256']; self.m['bytes'] = 999
        with self.assertRaisesRegex(ValueError, 'integrity'): self.plan()
    def test_rejects_raw_head_and_unknown_preprocessing(self):
        original = copy.deepcopy(self.m)
        self.m['output']['format'] = 'yolo_raw_xywh_class_scores'
        with self.assertRaisesRegex(ValueError, 'decoder'): self.plan()
        self.m = original; self.m['letterbox']['padding'] = 0
        with self.assertRaisesRegex(ValueError, 'preprocessing'): self.plan()
    def test_rejects_wrong_runtime_license_and_foreign_target(self):
        original = copy.deepcopy(self.m)
        self.m['runtimeVersion'] = '0.0.0'
        with self.assertRaisesRegex(ValueError, 'Runtime'): self.plan()
        self.m = copy.deepcopy(original); self.m['license'] = 'MIT'
        with self.assertRaisesRegex(ValueError, 'license'): self.plan()
        self.m = original; (self.public/self.m['file']).write_bytes(b'foreign')
        with self.assertRaisesRegex(ValueError, 'another artifact'): self.plan()
    def test_rejects_untrusted_previous_manifest_path(self):
        (self.public/'yolo26n-416.json').write_text(json.dumps({'file': '../other.onnx'}))
        with self.assertRaisesRegex(ValueError, 'Unsafe'): self.plan()


if __name__ == '__main__': unittest.main()
