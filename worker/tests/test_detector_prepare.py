"""Fresh-cache bootstrap regression. Export is explicitly simulated; GPU proof lives separately."""
import io
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
import onnx
from onnx import helper,TensorProto
from worker.runtime import prepare
from worker.vision.detector import MODEL_CATALOG


def test_source_catalog_bootstraps_empty_cache(monkeypatch,tmp_path):
    cache=tmp_path/'worker/models'
    assert MODEL_CATALOG.is_file() and MODEL_CATALOG.parent.name=='worker'
    assert not cache.exists()
    catalog=json.loads(MODEL_CATALOG.read_text())
    payload=b'explicitly-simulated-checkpoint'
    catalog['yolo26n']['bytes']=len(payload)
    catalog['yolo26n']['sha256']=hashlib.sha256(payload).hexdigest()
    catalog_path=tmp_path/'model-catalog.json'
    catalog_path.write_text(json.dumps(catalog))
    requested=[]
    def open_url(url,timeout):
        requested.append(url)
        return io.BytesIO(payload)
    class SimulatedExport:
        def __init__(self,path):self.path=Path(path)
        def export(self,**kwargs):
            assert kwargs['imgsz']==640 and kwargs['device']==0 and kwargs['nms'] is False
            graph=helper.make_graph([helper.make_node('Constant',[],['output0'],value=helper.make_tensor('constant',TensorProto.FLOAT,[1,300,6],[0.0]*1800))],
                'synthetic-bootstrap-test',[helper.make_tensor_value_info('images',TensorProto.FLOAT,[1,3,640,640])],
                [helper.make_tensor_value_info('output0',TensorProto.FLOAT,[1,300,6])])
            model=helper.make_model(graph,opset_imports=[helper.make_opsetid('',17)])
            onnx.save(model,self.path.with_suffix('.onnx'))
    monkeypatch.setattr(prepare,'MODEL_DIR',cache)
    monkeypatch.setattr(prepare,'MODEL_CATALOG',catalog_path)
    monkeypatch.setattr(prepare.urllib.request,'urlopen',open_url)
    monkeypatch.setitem(sys.modules,'ultralytics',SimpleNamespace(YOLO=SimulatedExport,__version__='synthetic-test'))
    prepare.prepare(['fast'])
    assert requested==[catalog['yolo26n']['source']]
    assert (cache/'yolo26n.pt').is_file()
    manifest=json.loads((cache/'yolo26n-onnx_cuda.json').read_text())
    assert manifest['checkpointSha256']==catalog['yolo26n']['sha256']
    assert manifest['inputShape']==[1,3,640,640]
    assert manifest['outputShape']==[1,300,6]
    requested.clear()
    prepare.prepare(['fast'])
    assert requested==[]
