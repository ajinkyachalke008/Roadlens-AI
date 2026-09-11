"""Reproducible official pretrained exports; no training or app data persistence."""
import os
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
(ROOT / 'training' / '.config').mkdir(parents=True, exist_ok=True)
os.environ['YOLO_CONFIG_DIR'] = str(ROOT / 'training' / '.config')
os.environ['YOLO_AUTOINSTALL'] = 'false'
import argparse, json, hashlib, shutil, urllib.request, importlib.metadata
import onnx
from ultralytics import YOLO

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--checkpoint',type=Path)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--model-id')
    parser.add_argument('--license')
    parser.add_argument('--source')
    args=parser.parse_args()
    custom=args.checkpoint is not None
    if custom and not all([args.output,args.model_id,args.license,args.source]):raise ValueError('Custom export requires --output staging directory, --model-id, --license, --source')
    weights = ROOT / 'training/weights'
    assets = args.output.resolve() if args.output else ROOT / 'frontend/public/models'
    if custom and assets.is_relative_to(ROOT/'frontend/public'):raise ValueError('Custom exports must be staged outside public assets until promotion')
    weights.mkdir(parents=True, exist_ok=True)
    assets.mkdir(parents=True, exist_ok=True)
    checkpoint = args.checkpoint.resolve() if custom else weights / 'yolo26n.pt'
    source = args.source or 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.pt'
    if not checkpoint.exists():
        if custom:raise FileNotFoundError(checkpoint)
        urllib.request.urlretrieve(source, checkpoint)
    checkpoint_hash=hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    if not custom and checkpoint_hash!='9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef':raise ValueError('Official checkpoint hash differs from pinned source; do not execute unverified weights')
    for side in (416, 320):
        model = YOLO(str(checkpoint))
        names=model.names
        supported={'person','bicycle','car','motorcycle','bus','truck'}
        class_map={str(k):v for k,v in names.items() if v in supported}
        if set(class_map.values())!=supported:raise ValueError('Checkpoint does not declare all six supported semantic classes')
        exported = model.export(format='onnx', imgsz=side, batch=1, dynamic=False, half=False, nms=False, simplify=False, opset=17, device='cpu')
        prefix=args.model_id or 'yolo26n'
        if not prefix.replace('-','').replace('_','').isalnum():raise ValueError('Model ID must contain only letters, numbers, hyphens, underscores')
        target = assets / f'{prefix}-{side}.onnx'
        shutil.copyfile(exported, target)
        graph = onnx.load(target)
        onnx.checker.check_model(graph)
        def tensor(v):
            t = v.type.tensor_type
            assert t.elem_type == onnx.TensorProto.FLOAT
            return {'name': v.name, 'shape': [d.dim_value for d in t.shape.dim], 'dtype': 'float32'}
        input_info, output_info = tensor(graph.graph.input[0]), tensor(graph.graph.output[0])
        assert input_info['shape'] == [1, 3, side, side]
        assert output_info['shape'] == [1, 300, 6], output_info
        manifest = {
            'id': f'{args.model_id or "yolo26n-coco"}-e2e-{side}-fp32-v1', 'file': target.name, 'profile': side,
            'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'bytes': target.stat().st_size,
            'source': source, 'checkpointSha256': checkpoint_hash,
            'license': args.license or 'AGPL-3.0', 'licenseUrl': 'https://www.ultralytics.com/license',
            'input': {**input_info, 'color':'RGB','layout':'NCHW','normalization':'divide_255'},
            'output': {**output_info, 'format':'yolo_e2e_xyxy_score_class'},
            'letterbox': {'padding':114,'rounding':'half_up','resize':'pixel_center_bilinear_no_antialias','extraPadding':'bottom_right'},
            'classMap': class_map, 'classCount':len(names),
            'confidence': {'low':0.1,'high':0.5,'newTrack':0.6}, 'decoderVersion':'roadlens_decode_v1',
            'exportOptions': {'format':'onnx','imgsz':side,'batch':1,'dynamic':False,'half':False,'nms':False,'simplify':False,'opset':17,'device':'cpu'},
            'exporterVersion': importlib.metadata.version('ultralytics'), 'torchVersion':importlib.metadata.version('torch'),
            'onnxVersion':onnx.__version__, 'runtimeVersion':json.loads((ROOT/'node_modules/onnxruntime-web/package.json').read_text())['version'],
            'graphOperators': sorted(set(n.op_type for n in graph.graph.node)),
            'graphMetadata': {p.key:p.value for p in graph.metadata_props},
            'testedExecutionProviders':[], 'browserParity':'NOT_RUN', 'physicalPhoneBenchmark':'NOT_RUN'
        }
        (assets / f'{prefix}-{side}.json').write_text(json.dumps(manifest,indent=2)+'\n')
        print(json.dumps({'id':manifest['id'],'bytes':manifest['bytes'],'sha256':manifest['sha256'],'output':output_info}))
    urllib.request.urlretrieve('https://raw.githubusercontent.com/ultralytics/ultralytics/v8.4.146/LICENSE', assets/'ULTRALYTICS-LICENSE.txt')

if __name__ == '__main__': main()
