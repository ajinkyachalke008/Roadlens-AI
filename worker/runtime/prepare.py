"""Explicit one-time setup: bounded checkpoints, fixed ONNX export, optional TensorRT build."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path
from worker.vision.detector import MODEL_DIR,MODEL_CATALOG,MODELS


def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def bounded_engine_build(onnx_path,target,timeout=300):
    """Terminate only our own builder tree if native compilation exceeds setup's cap."""
    command=[sys.executable,'-m','worker.runtime.tensorrt','--onnx',str(onnx_path),'--output',str(target)]
    options=dict(stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,cwd=str(MODEL_DIR.parents[1]))
    if os.name=='nt':options['creationflags']=subprocess.CREATE_NO_WINDOW
    process=subprocess.Popen(command,**options)
    try:
        stdout,stderr=process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        if os.name=='nt':
            subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],capture_output=True,timeout=10)
        else:process.kill()
        process.communicate(timeout=10)
        raise RuntimeError('TensorRT engine build exceeded 300 seconds; keep PyTorch CUDA selected')
    if process.returncode:
        raise RuntimeError('TensorRT engine build failed; keep PyTorch CUDA selected')
    return json.loads(stdout.strip().splitlines()[-1])


def prepare(model_modes=('fast','balanced','quality'),build_tensorrt=False):
    MODEL_DIR.mkdir(parents=True,exist_ok=True)
    os.environ['YOLO_CONFIG_DIR']=str(MODEL_DIR.parent/'.config')
    os.environ['YOLO_AUTOINSTALL']='false'
    import onnx
    import torch
    import ultralytics
    from ultralytics import YOLO
    catalog=json.loads(MODEL_CATALOG.read_text())
    for mode in model_modes:
        name=MODELS[mode];entry=catalog[name];checkpoint=MODEL_DIR/entry['file']
        if not checkpoint.exists():
            with urllib.request.urlopen(entry['source'],timeout=60) as response:
                payload=response.read(entry['bytes']+1)
            if len(payload)!=entry['bytes'] or hashlib.sha256(payload).hexdigest()!=entry['sha256']:
                raise RuntimeError('Official checkpoint integrity mismatch')
            checkpoint.write_bytes(payload)
        if checkpoint.stat().st_size!=entry['bytes'] or digest(checkpoint)!=entry['sha256']:
            raise RuntimeError('Cached checkpoint integrity mismatch')
        onnx_path=MODEL_DIR/f'{name}.onnx';manifest_path=MODEL_DIR/f'{name}-onnx_cuda.json'
        if not (onnx_path.exists() and manifest_path.exists()):
            YOLO(str(checkpoint)).export(format='onnx',imgsz=640,batch=1,dynamic=False,half=False,nms=False,simplify=False,opset=17,device=0)
            graph=onnx.load(str(onnx_path));onnx.checker.check_model(graph)
            shapes=lambda item:[d.dim_value for d in item.type.tensor_type.shape.dim]
            if len(graph.graph.input)!=1 or len(graph.graph.output)!=1 or graph.graph.input[0].name!='images' or graph.graph.output[0].name!='output0' or shapes(graph.graph.input[0])!=[1,3,640,640] or shapes(graph.graph.output[0])!=[1,300,6]:
                raise RuntimeError('Exported graph head is unsupported')
            manifest=dict(file=onnx_path.name,bytes=onnx_path.stat().st_size,sha256=digest(onnx_path),
                checkpointSha256=entry['sha256'],source=entry['source'],license=entry['license'],
                inputShape=[1,3,640,640],outputShape=[1,300,6],inputName='images',outputName='output0',
                outputFormat='yolo_e2e_xyxy_score_class',exporterVersion=ultralytics.__version__,torchVersion=torch.__version__,
                onnxVersion=onnx.__version__,opset=17,precision='FP32',runtimeVersion='1.29.0')
            manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
        manifest=json.loads(manifest_path.read_text())
        if digest(onnx_path)!=manifest['sha256']:raise RuntimeError('Cached ONNX integrity mismatch')
        if build_tensorrt:
            target=MODEL_DIR/f'{name}-640-fp16.engine';engine_manifest=MODEL_DIR/f'{name}-tensorrt.json'
            if not (target.exists() and engine_manifest.exists()):
                details=bounded_engine_build(onnx_path,target)
                engine_manifest.write_text(json.dumps(manifest|details|dict(file=target.name,bytes=target.stat().st_size,sha256=digest(target),onnxSha256=manifest['sha256']),indent=2)+'\n')
            if digest(target)!=json.loads(engine_manifest.read_text())['sha256']:raise RuntimeError('Cached TensorRT integrity mismatch')
        print(f'{name}: verified checkpoint and fixed 640 ONNX'+(' / TensorRT engine' if build_tensorrt else ''))


def main():
    p=argparse.ArgumentParser();p.add_argument('--models',nargs='+',choices=list(MODELS),default=list(MODELS));p.add_argument('--build-tensorrt',action='store_true')
    args=p.parse_args();prepare(args.models,args.build_tensorrt)


if __name__=='__main__':main()
