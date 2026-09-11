"""Real upstream photo: deterministic preprocessing + independent PyTorch/ONNX parity."""
import os
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
(ROOT/'training/.config').mkdir(parents=True,exist_ok=True)
os.environ['YOLO_CONFIG_DIR']=str(ROOT/'training/.config')
import json, hashlib, urllib.request
import numpy as np
from PIL import Image
import torch, onnxruntime as ort
from ultralytics import YOLO

def preprocess(rgb,side):
    h,w,_=rgb.shape
    scale=min(side/w,side/h)
    rw,rh=int(w*scale+0.5),int(h*scale+0.5)
    left,top=(side-rw)//2,(side-rh)//2
    xs=np.clip((np.arange(rw)+0.5)/(rw/w)-0.5,0,w-1)
    ys=np.clip((np.arange(rh)+0.5)/(rh/h)-0.5,0,h-1)
    x0,y0=np.floor(xs).astype(int),np.floor(ys).astype(int)
    x1,y1=np.minimum(x0+1,w-1),np.minimum(y0+1,h-1)
    fx,fy=xs-x0,ys-y0
    image=rgb.astype(np.float64)
    a=image[y0[:,None],x0[None,:]];b=image[y0[:,None],x1[None,:]]
    d=image[y1[:,None],x0[None,:]];e=image[y1[:,None],x1[None,:]]
    scaled=(a*(1-fx[None,:,None])+b*fx[None,:,None])*(1-fy[:,None,None])+(d*(1-fx[None,:,None])+e*fx[None,:,None])*fy[:,None,None]
    result=np.full((side,side,3),114/255,dtype=np.float32)
    result[top:top+rh,left:left+rw]=scaled/255
    return np.transpose(result,(2,0,1))[None].copy(), {'width':w,'height':h,'side':side,'resizedWidth':rw,'resizedHeight':rh,'left':left,'top':top,'scaleX':rw/w,'scaleY':rh/h}

def main():
    fixture=ROOT/'tests/fixtures';fixture.mkdir(parents=True,exist_ok=True)
    demo=ROOT/'frontend/public/demo';demo.mkdir(parents=True,exist_ok=True)
    source='https://raw.githubusercontent.com/ultralytics/ultralytics/v8.4.146/ultralytics/assets/bus.jpg'
    original=fixture/'bus.jpg'
    if not original.exists():urllib.request.urlretrieve(source,original)
    image=Image.open(original).convert('RGB')
    image.save(demo/'bus.png')
    # Landscape derivative of same permitted photo, padding avoids silently changing road geometry.
    landscape=Image.new('RGB',(1440,1080),(114,114,114));landscape.paste(image,(315,0));landscape.save(demo/'bus-landscape.png')
    evidence={'source':source,'license':'AGPL-3.0 (upstream repository sample)','sha256':hashlib.sha256(original.read_bytes()).hexdigest(),'cases':[]}
    for side in (416,320):
        session=ort.InferenceSession(str(ROOT/f'frontend/public/models/yolo26n-{side}.onnx'),providers=['CPUExecutionProvider'])
        model=YOLO(str(ROOT/'training/weights/yolo26n.pt')).model
        model.end2end=True;model.eval();model.fuse()
        for name in ('bus','bus-landscape'):
            rgb=np.array(Image.open(demo/f'{name}.png').convert('RGB'))
            tensor,info=preprocess(rgb,side)
            with torch.no_grad(): output=model(torch.from_numpy(tensor))
            reference=output[0] if isinstance(output,tuple) else output
            reference=reference.numpy()
            actual=session.run(None,{'images':tensor})[0]
            # Match meaningful rows by rank; tiny-score tail order is not a semantic assertion.
            valid=reference[0,:,4]>=0.1
            delta=float(np.max(np.abs(reference[0,valid]-actual[0,valid])))
            assert delta<0.01,(name,side,delta)
            row={'name':name,'side':side,'letterbox':info,'torchOnnxMaxAbsDelta':delta,'inputSha256':hashlib.sha256(tensor.tobytes()).hexdigest(),'shape':list(actual.shape),'output':actual.reshape(-1).tolist()}
            (fixture/f'{name}-{side}-reference.json').write_text(json.dumps(row)+'\n')
            evidence['cases'].append({'name':name,'side':side,'torchOnnxMaxAbsDelta':delta,'detectionsAbove01':int(valid.sum())})
            print(evidence['cases'][-1])
    (fixture/'provenance.json').write_text(json.dumps(evidence,indent=2)+'\n')

if __name__=='__main__':main()
