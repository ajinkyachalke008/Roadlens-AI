"""Inspected YOLO26 end-to-end [1,300,6] xyxy/score/class decoder."""
import numpy as np
CLASSES = {0:'person',1:'bicycle',2:'car',3:'motorcycle',5:'bus',7:'truck'}


def decode(output, info):
    if not isinstance(output,np.ndarray) or output.shape != (1,300,6) or not np.isfinite(output).all():
        raise RuntimeError('Unsupported or nonfinite detector output')
    selected=[]
    for x1,y1,x2,y2,score,cls in output[0]:
        if not 0 <= score <= 1 or cls != int(cls) or not 0 <= cls < 80:
            raise RuntimeError('Invalid detector output semantics')
        if score < 0.1 or int(cls) not in CLASSES:
            continue
        box=[float(np.clip((x1-info['left'])/info['scaleX']/info['width'],0,1)),
             float(np.clip((y1-info['top'])/info['scaleY']/info['height'],0,1)),
             float(np.clip((x2-info['left'])/info['scaleX']/info['width'],0,1)),
             float(np.clip((y2-info['top'])/info['scaleY']/info['height'],0,1))]
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        selected.append(dict(bbox=box,className=CLASSES[int(cls)],score=float(score)))
    return sorted(selected,key=lambda d:-d['score'])[:100]
