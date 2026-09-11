"""Real GPU inference and synthetic decoder/transport-input regression tests."""
from pathlib import Path
import io
import numpy as np
import pytest
from PIL import Image
from worker.vision.preprocess import decode_jpeg,letterbox
from worker.vision.postprocess import decode
from worker.vision.detector import Detector

FIXTURE=Path(__file__).resolve().parents[2]/'tests/fixtures/bus.jpg'


def test_jpeg_dimension_mismatch_rejected_before_decode():
    with pytest.raises(ValueError,match='dimensions'):decode_jpeg(FIXTURE.read_bytes(),640,480)


def test_invalid_and_oversized_images():
    for payload in (b'',b'not jpeg',b'\xff\xd8'+b'x'*(512*1024)):
        with pytest.raises(ValueError):decode_jpeg(payload,810,1080)
    with pytest.raises(ValueError):decode_jpeg(FIXTURE.read_bytes(),4096,4096)


def test_rgb_layout_letterbox_and_coordinate_inversion():
    rgb=np.zeros((320,640,3),dtype=np.uint8);rgb[:,:,0]=255
    tensor,info=letterbox(rgb)
    assert tensor.shape==(1,3,640,640)
    assert tensor[0,0,160,0]==1 and tensor[0,2,160,0]==0
    assert tensor[0,0,0,0]==pytest.approx(114/255)
    output=np.zeros((1,300,6),dtype=np.float32);output[0,0]=[0,160,640,480,.9,5]
    result=decode(output,info)
    assert result[0]['className']=='bus' and result[0]['bbox']==[0,0,1,1]


def test_decoder_rejects_unknown_shape_nonfinite_and_wrong_class_semantics():
    _,info=letterbox(np.zeros((320,640,3),dtype=np.uint8))
    for output in (np.zeros((1,84,8400),dtype=np.float32),np.full((1,300,6),np.nan,dtype=np.float32)):
        with pytest.raises(RuntimeError):decode(output,info)
    output=np.zeros((1,300,6),dtype=np.float32);output[0,0,5]=80
    with pytest.raises(RuntimeError):decode(output,info)


def test_no_cpu_mode_and_extreme_aspect():
    with pytest.raises(ValueError):Detector(runtime='cpu')
    with pytest.raises(ValueError):letterbox(np.zeros((1,10000,3),dtype=np.uint8))


def iou(a,b):
    intersection=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    return intersection/((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection)


@pytest.mark.parametrize('mode',['fast','balanced','quality'])
def test_real_cuda_model_and_onnx_parity(mode):
    import torch
    if not torch.cuda.is_available():pytest.skip('Actual NVIDIA CUDA hardware unavailable')
    payload=FIXTURE.read_bytes()
    reference=Detector(mode,'pytorch_cuda')
    try:
        assert reference.warmup(3)['gpuVerified']
        observed=reference.detect_jpeg(payload,810,1080)
        assert reference.health()['ready']
        assert any(x['className']=='bus' for x in observed['detections'])
        assert any(x['className']=='person' for x in observed['detections'])
        assert all(0<=v<=1 for d in observed['detections'] for v in d['bbox'])
        assert all(v>=0 for v in observed['timing'].values())
    finally:reference.close()
    with pytest.raises(RuntimeError,match='not ready'):reference.detect_jpeg(payload,810,1080)
    cuda=Detector(mode,'onnx_cuda')
    try:
        cuda.warmup(3);result=cuda.detect_jpeg(payload,810,1080)
        assert len(result['detections'])==len(observed['detections'])
        for target in observed['detections']:
            matches=[d for d in result['detections'] if d['className']==target['className'] and iou(d['bbox'],target['bbox'])>.99 and abs(d['score']-target['score'])<.005]
            assert matches, target
    finally:cuda.close()
