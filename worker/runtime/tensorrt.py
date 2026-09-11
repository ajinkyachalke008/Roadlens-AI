"""Pinned TensorRT10 CUDA runtime using named tensors and a single GPU stream."""
import json
from pathlib import Path
import numpy as np


class TensorRT:
    def __init__(self,path,manifest,device=0):
        import torch
        import tensorrt as trt
        self.device=device
        if manifest.get('tensorrtVersion')!=trt.__version__ or manifest.get('gpu')!=torch.cuda.get_device_name(device) or manifest.get('cudaRuntime')!=torch.version.cuda:
            raise RuntimeError('TensorRT engine environment changed; rebuild explicitly during setup')
        self.logger=trt.Logger(trt.Logger.ERROR)
        self.runtime=trt.Runtime(self.logger)
        self.engine=self.runtime.deserialize_cuda_engine(Path(path).read_bytes())
        if self.engine is None:raise RuntimeError('TensorRT engine deserialization failed')
        names=[self.engine.get_tensor_name(i) for i in range(self.engine.num_io_tensors)]
        if names!=['images','output0'] or tuple(self.engine.get_tensor_shape('images'))!=(1,3,640,640) or tuple(self.engine.get_tensor_shape('output0'))!=(1,300,6):
            raise RuntimeError('Unexpected TensorRT tensors')
        self.context=self.engine.create_execution_context()
        if self.context is None:raise RuntimeError('TensorRT execution context failed')
        self.stream=torch.cuda.Stream(device=device)
        self.buffers={}
        for name in names:
            dtype=trt.nptype(self.engine.get_tensor_dtype(name))
            if dtype not in (np.float16,np.float32):raise RuntimeError('Unsupported TensorRT tensor dtype')
            self.buffers[name]=torch.empty(tuple(self.engine.get_tensor_shape(name)),device=f'cuda:{device}',dtype=torch.float16 if dtype==np.float16 else torch.float32)
            if not self.context.set_tensor_address(name,self.buffers[name].data_ptr()):raise RuntimeError('TensorRT binding failed')
    def run(self,tensor):
        import torch
        with torch.cuda.stream(self.stream):
            self.buffers['images'].copy_(torch.from_numpy(tensor))
            if not self.context.execute_async_v3(self.stream.cuda_stream):raise RuntimeError('TensorRT GPU execution failed')
        self.stream.synchronize()
        return self.buffers['output0'].float().cpu().numpy().copy()
    def close(self):
        import torch
        self.stream.synchronize()
        self.context=None;self.engine=None;self.runtime=None;self.buffers.clear()
        torch.cuda.empty_cache()


def build_engine(onnx_path,path,device=0):
    import torch
    import tensorrt as trt
    if not trt.__version__.startswith('10.13.3.'):
        raise RuntimeError('Unverified TensorRT builder version')
    torch.cuda.set_device(device)
    logger=trt.Logger(trt.Logger.WARNING)
    builder=trt.Builder(logger)
    network=builder.create_network(0)
    parser=trt.OnnxParser(network,logger)
    if not parser.parse_from_file(str(onnx_path)):
        raise RuntimeError('TensorRT ONNX parsing failed: '+str(parser.get_error(0)))
    config=builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE,2*1024**3)
    config.set_flag(trt.BuilderFlag.FP16)
    config.clear_flag(trt.BuilderFlag.TF32)
    config.builder_optimization_level=3
    serialized=builder.build_serialized_network(network,config)
    if serialized is None:raise RuntimeError('TensorRT engine build failed')
    Path(path).write_bytes(bytes(serialized))
    return dict(tensorrtVersion=trt.__version__,gpu=torch.cuda.get_device_name(device),
                cudaRuntime=torch.version.cuda,precision='FP16 mixed GPU tactics',workspaceBytes=2*1024**3)


if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser()
    p.add_argument('--onnx',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    args=p.parse_args()
    print(json.dumps(build_engine(args.onnx,args.output)))
