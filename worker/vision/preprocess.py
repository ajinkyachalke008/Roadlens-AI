"""Bounded JPEG decode and explicit RGB fixed-square letterbox."""
from io import BytesIO
import math
import numpy as np
from PIL import Image


def decode_jpeg(payload, expected_width, expected_height):
    if not isinstance(payload, bytes) or not 4 <= len(payload) <= 512*1024 or payload[:2] != b'\xff\xd8':
        raise ValueError('Invalid bounded JPEG')
    if any(type(v) is not int or not 1 <= v <= 4096 for v in (expected_width, expected_height)) or expected_width*expected_height > 4194304:
        raise ValueError('Unsupported encoded dimensions')
    with Image.open(BytesIO(payload)) as image:
        # Pillow parses SOF dimensions before allocating the decoded raster.
        if image.format != 'JPEG' or image.size != (expected_width, expected_height):
            raise ValueError('JPEG dimensions mismatch')
        image.load()
        return np.asarray(image.convert('RGB'))


def letterbox(rgb, side=640):
    import cv2
    if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8 or side != 640:
        raise ValueError('Unsupported RGB input')
    h,w = rgb.shape[:2]
    ratio = min(side/w, side/h)
    rw,rh = int(math.floor(w*ratio+0.5)),int(math.floor(h*ratio+0.5))
    if min(rw,rh) < 1:
        raise ValueError('Unsupported image aspect ratio')
    left,top = (side-rw)//2,(side-rh)//2
    resized = cv2.resize(rgb, (rw,rh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((side,side,3),114,dtype=np.uint8)
    canvas[top:top+rh,left:left+rw] = resized
    tensor = np.ascontiguousarray(canvas.transpose(2,0,1)[None],dtype=np.float32)/255.0
    return tensor,dict(width=w,height=h,left=left,top=top,scaleX=rw/w,scaleY=rh/h)
