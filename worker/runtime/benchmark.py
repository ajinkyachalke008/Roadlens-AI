"""Bounded actual-GPU benchmarks on the permitted project photo; no accuracy claims."""
import argparse
import hashlib
import json
import statistics
from datetime import datetime,timezone
from pathlib import Path
from worker.vision.detector import Detector,MODELS
from worker.runtime.gpu import preflight


def benchmark(iterations=20,warmup=5,runtimes=('pytorch_cuda','onnx_cuda'),models=tuple(MODELS),output=None):
    if not 1<=iterations<=100 or not 1<=warmup<=20:raise ValueError('Benchmark exceeds bounded iteration limits')
    fixture=Path(__file__).resolve().parents[2]/'tests/fixtures/bus.jpg'
    payload=fixture.read_bytes()
    report=dict(testedAt=datetime.now(timezone.utc).isoformat(),environment=preflight(),
                fixture=dict(path='tests/fixtures/bus.jpg',sha256=hashlib.sha256(payload).hexdigest(),
                    width=810,height=1080,limitation='One permitted photo, repeated; no field accuracy, motion or phone/network benchmark'),
                iterations=iterations,warmup=warmup,results=[])
    for runtime in runtimes:
        for mode in models:
            detector=None
            try:
                detector=Detector(mode,runtime)
                warmup_result=detector.warmup(warmup)
                # Decode one real photo before steady measurements to initialize image libraries.
                detector.detect_jpeg(payload,810,1080)
                runs=[detector.detect_jpeg(payload,810,1080) for _ in range(iterations)]
                timing={key:dict(median=statistics.median(r['timing'][key] for r in runs),
                            p95=sorted(r['timing'][key] for r in runs)[min(iterations-1,int(iterations*.95))]) for key in runs[0]['timing']}
                row=dict(status='PASS',mode=mode,runtime=runtime,inputSize=640,modelId=runs[0]['modelId'],
                    modelSha256=runs[0]['modelSha256'],timing=timing,warmup=warmup_result,health=detector.health(),
                    detections=runs[-1]['detections'],throughputHz=1000/timing['totalMs']['median'])
                print(f'{mode:8} {runtime:13} inference {timing["inferenceMs"]["median"]:.2f} ms total {timing["totalMs"]["median"]:.2f} ms {len(runs[-1]["detections"])} detections')
            except Exception as error:
                row=dict(status='FAIL',mode=mode,runtime=runtime,error=str(error))
                print(f'{mode:8} {runtime:13} FAIL: {type(error).__name__}: {error}')
            finally:
                if detector:detector.close()
            report['results'].append(row)
    if output:
        output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps(report,indent=2)+'\n')
    return report


def main():
    p=argparse.ArgumentParser();p.add_argument('--iterations',type=int,default=20);p.add_argument('--warmup',type=int,default=5)
    p.add_argument('--runtimes',nargs='+',choices=['pytorch_cuda','onnx_cuda','tensorrt'],default=['pytorch_cuda','onnx_cuda'])
    p.add_argument('--models',nargs='+',choices=list(MODELS),default=list(MODELS));p.add_argument('--output',type=Path,default=Path('docs/evidence/gpu-benchmark.json'))
    args=p.parse_args();r=benchmark(args.iterations,args.warmup,args.runtimes,args.models,args.output)
    if any(x['status']!='PASS' for x in r['results']):raise SystemExit(1)


if __name__=='__main__':main()
