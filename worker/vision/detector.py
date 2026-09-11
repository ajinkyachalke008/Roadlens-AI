"""Hash-pinned traffic detector facade. Synchronous; caller serializes work."""
import hashlib
import json
import re
from pathlib import Path
from time import perf_counter
import numpy as np
from worker.runtime.gpu import preflight
from worker.vision.preprocess import decode_jpeg,letterbox
from worker.vision.postprocess import decode

MODELS={'fast':'yolo26n','balanced':'yolo26s','quality':'yolo26m'}
MODEL_DIR=Path(__file__).resolve().parents[1]/'models'
MODEL_CATALOG=Path(__file__).resolve().parents[1]/'model-catalog.json'


class Detector:
    def __init__(self,model_mode='balanced',runtime='pytorch_cuda',device=0):
        if model_mode not in MODELS or runtime not in ('pytorch_cuda','onnx_cuda','tensorrt'):
            raise ValueError('Unsupported verified detector mode/runtime')
        self.ready=False;self.closed=False;self.device=device;self.runtime=runtime
        self.gpu_info=preflight(device)
        name=MODELS[model_mode]
        catalog=json.loads(MODEL_CATALOG.read_text())
        if runtime=='pytorch_cuda':
            entry=catalog[name]
        else:
            manifest=MODEL_DIR/f'{name}-{runtime}.json'
            if not manifest.is_file():raise RuntimeError('GPU artifact not prepared; run setup-worker.ps1 first')
            entry=json.loads(manifest.read_text())
            if entry.get('inputShape') != [1,3,640,640] or entry.get('outputShape') != [1,300,6] or entry.get('checkpointSha256') != catalog[name]['sha256']:
                raise RuntimeError('GPU artifact metadata incompatible')
        if not re.fullmatch(r'[A-Za-z0-9_-]+\.(pt|onnx|engine)',entry.get('file','')):
            raise RuntimeError('Invalid GPU artifact filename')
        path=MODEL_DIR/entry['file']
        if path.is_symlink() or not path.resolve().is_relative_to(MODEL_DIR.resolve()):
            raise RuntimeError('GPU artifact escapes model directory')
        if not path.is_file() or path.stat().st_size != entry['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest()!=entry['sha256']:
            raise RuntimeError('GPU model missing or integrity mismatch; run setup-worker.ps1')
        self.model_id=f'{name}-640-{runtime}-v1';self.model_sha256=entry['sha256']
        if runtime=='pytorch_cuda':
            from worker.runtime.pytorch_cuda import PyTorchCuda
            self.engine=PyTorchCuda(path,device)
        elif runtime=='onnx_cuda':
            from worker.runtime.onnx_cuda import OnnxCuda
            self.engine=OnnxCuda(path,device)
        else:
            from worker.runtime.tensorrt import TensorRT
            self.engine=TensorRT(path,entry,device)
    def warmup(self,iterations=5):
        if self.closed or type(iterations) is not int or not 1<=iterations<=20:
            raise ValueError('Invalid bounded warmup')
        started=perf_counter()
        for _ in range(iterations):
            output=self.engine.run(np.full((1,3,640,640),114/255,dtype=np.float32))
            if output.shape!=(1,300,6) or not np.isfinite(output).all():raise RuntimeError('GPU warmup output invalid')
        self.ready=True
        return dict(iterations=iterations,elapsedMs=(perf_counter()-started)*1000,runtime=self.runtime,gpuVerified=True)
    def detect_jpeg(self,payload,expected_width,expected_height):
        if not self.ready or self.closed:raise RuntimeError('GPU detector not ready')
        started=perf_counter()
        rgb=decode_jpeg(payload,expected_width,expected_height);decoded=perf_counter()
        tensor,info=letterbox(rgb);preprocessed=perf_counter()
        output=self.engine.run(tensor);inferred=perf_counter()
        detections=decode(output,info);finished=perf_counter()
        return dict(detections=detections,timing=dict(decodeMs=(decoded-started)*1000,
                    preprocessMs=(preprocessed-decoded)*1000,inferenceMs=(inferred-preprocessed)*1000,
                    postprocessMs=(finished-inferred)*1000,totalMs=(finished-started)*1000),
                    runtime=self.runtime,inputSize=640,modelId=self.model_id,modelSha256=self.model_sha256)
    def health(self):
        import torch
        return dict(ready=self.ready and not self.closed,runtime=self.runtime,modelId=self.model_id,
                    modelSha256=self.model_sha256,inputSize=640,gpu=self.gpu_info['gpu'],device=self.device,
                    vramAllocatedMiB=round(torch.cuda.memory_allocated(self.device)/1048576,2))
    def close(self):
        self.ready=False
        if self.closed:return
        self.closed=True
        self.engine.close()
