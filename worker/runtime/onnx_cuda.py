"""ORT CUDA with CPU execution-provider fallback explicitly prohibited."""
class OnnxCuda:
    def __init__(self,path,device=0):
        import torch
        import onnxruntime as ort
        self.device=device
        if 'CUDAExecutionProvider' not in ort.get_available_providers():
            raise RuntimeError('ONNX CUDA execution provider unavailable')
        ort.preload_dlls()
        if not any(d.ep_name=='CUDAExecutionProvider' for d in ort.get_ep_devices()):
            # This 1.29 Windows wheel bundles a CUDA plugin but omits its auto-register build flag.
            from pathlib import Path
            ort.register_execution_provider_library('CUDAExecutionProvider',str(Path(ort.__file__).parent/'capi/onnxruntime_providers_cuda.dll'))
        options=ort.SessionOptions()
        options.add_session_config_entry('session.disable_cpu_ep_fallback','1')
        self.session=ort.InferenceSession(str(path),sess_options=options,providers=[('CUDAExecutionProvider',{'device_id':device,'cudnn_conv_algo_search':'HEURISTIC','gpu_mem_limit':4*1024**3,'use_tf32':0})])
        self.session.disable_fallback()
        if self.session.get_providers()[0]!='CUDAExecutionProvider':
            raise RuntimeError('ONNX session permits unexpected providers')
        inp,out=self.session.get_inputs(),self.session.get_outputs()
        if len(inp)!=1 or inp[0].name!='images' or inp[0].shape!=[1,3,640,640] or len(out)!=1 or out[0].name!='output0' or out[0].shape!=[1,300,6]:
            raise RuntimeError('Unexpected ONNX graph tensors')
    def run(self,tensor):
        import torch
        import onnxruntime as ort
        value=ort.OrtValue.ortvalue_from_numpy(tensor,'cuda',self.device)
        binding=self.session.io_binding()
        binding.bind_ortvalue_input('images',value)
        binding.bind_output('output0','cuda',self.device)
        self.session.run_with_iobinding(binding)
        output=binding.get_outputs()[0]
        if output.device_name()!='cuda':raise RuntimeError('ONNX output was not produced on CUDA')
        torch.cuda.synchronize(self.device)
        return output.numpy()
    def close(self):
        self.session=None
