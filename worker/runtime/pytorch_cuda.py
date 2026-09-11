"""Explicit CUDA PyTorch runtime; never use Ultralytics device auto-selection."""
import os
from pathlib import Path
import numpy as np


class PyTorchCuda:
    def __init__(self,path,device=0):
        import torch
        os.environ['YOLO_CONFIG_DIR']=str(Path(__file__).resolve().parents[1]/'.config')
        os.environ['YOLO_AUTOINSTALL']='false'
        from ultralytics import YOLO
        self.device=device
        self.model=YOLO(str(path)).model.eval().to(f'cuda:{device}').float()
        self.model.end2end=True
        self.model.fuse(verbose=False)
        head=self.model.model[-1]
        if not getattr(head,'end2end',False):
            raise RuntimeError('Checkpoint does not have inspected end-to-end head')
        head.export=True;head.format='onnx';head.dynamic=False;head.max_det=300
        expected={0:'person',1:'bicycle',2:'car',3:'motorcycle',5:'bus',7:'truck'}
        if any(self.model.names.get(k)!=v for k,v in expected.items()):
            raise RuntimeError('Checkpoint semantic mapping mismatch')
        if not all(p.is_cuda and p.device.index==device for p in self.model.parameters()):
            raise RuntimeError('Model tensors are not on requested CUDA GPU')
    def run(self,tensor):
        import torch
        with torch.inference_mode():
            image=torch.from_numpy(tensor).to(f'cuda:{self.device}')
            output=self.model(image)
            if not isinstance(output,torch.Tensor) or not output.is_cuda:
                raise RuntimeError('Inference did not produce CUDA output')
            torch.cuda.synchronize(self.device)
            return output.float().cpu().numpy()
    def close(self):
        import torch
        self.model=None
        torch.cuda.empty_cache()
