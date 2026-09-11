# GPU model/runtime benchmark

Measured September 11, 2026 on the local NVIDIA GeForce RTX 5070 Ti (16,303 MiB, compute capability 12.0). The selected initial worker mode is **balanced: YOLO26s, 640 square, PyTorch CUDA FP32**. Browser YOLO26n remains the fallback. This choice is based on working runtime behavior and the narrow measurements below, not a new accuracy or field-speed claim.

## Actual compatible environment

| Component | Observed version |
|---|---|
| Isolated interpreter | `worker/.venv/Scripts/python`, Python 3.13.12 |
| NVIDIA driver | 610.74 |
| Installed toolkit | CUDA 13.0, nvcc 13.0.48 |
| PyTorch / bundled CUDA | 2.14.0+cu130 / 13.0 |
| torchvision | 0.29.0+cu130 |
| cuDNN reported by Torch | 92400 (9.24.0) |
| Ultralytics | 8.4.146 |
| ONNX | 1.20.1 |
| ONNX Runtime GPU | 1.29.0 |
| TensorRT experiment | 10.13.3.9.post1 cu13; no completed engine |
| WebSocket client | websockets 17.0.1 |

`worker/requirements.txt` pins the installed base environment, including official PyTorch cu130 wheels. `worker/requirements-tensorrt.txt` adds optional TensorRT dependencies. The latter's resolver supplied isolated CUDA toolkit metapackage 13.4.1.0 and CUDA runtime wheel 13.4.49; these do not replace the system toolkit. The successful Torch/ORT execution used the already loaded Torch CUDA 13.0/cuDNN libraries. No global Python, CUDA, driver or machine configuration was changed.

Current [ORT CUDA compatibility documentation](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html) explicitly lists 1.29.x with CUDA 13.0 and cuDNN 9.x; versions before 1.27 use a different default CUDA major. The actual official [PyTorch CUDA 13.0 index](https://download.pytorch.org/whl/cu130/torch/) supplied a cp313 Windows wheel with `sm_120` support. A real CUDA convolution and actual model forward both passed; availability alone was not accepted as proof.

The installed ORT Windows wheel exposed CUDA as available but failed initial device selection because its bundled plugin was not registered. Its build-info string omitted the auto-registration flag described by [Microsoft's CUDA plugin guide](https://github.com/microsoft/onnxruntime/blob/main/docs/cuda_plugin_ep/QUICK_START.md). Explicit public `register_execution_provider_library` registration of the bundled DLL fixed initialization. The application retains `session.disable_cpu_ep_fallback=1`, disables runtime fallback, binds input/output to CUDA, and asserts CUDA output. A real YOLO26s profile recorded **290 CUDA nodes and zero CPU nodes**. ORT still lists its registered CPU provider in `get_providers()`; that inventory alone is not node placement evidence.

## Clean benchmark results

Command:

```powershell
worker/.venv/Scripts/python -m worker.runtime.benchmark --iterations 20 --warmup 5 --output docs/evidence/gpu-benchmark.json
```

The final run started `2026-09-11T02:49:14.916879+00:00`, after stopping all engine-building work. Earlier overlapping measurements were discarded. Each candidate had five warmup forwards, one untimed real-photo decode/inference, then twenty measured runs. GPU completion is synchronized before timing stops. Inference timings include input transfer and output retrieval; total includes JPEG decode, RGB letterboxing, inference and semantic postprocessing. No tracking/network/browser rendering occurs inside these totals.

| Model / input | Runtime | Median inference ms | Median total ms | Detections |
|---|---|---:|---:|---:|
| YOLO26n / 640 | PyTorch CUDA | 7.29 | 13.79 | 5 |
| YOLO26s / 640 | PyTorch CUDA | 7.40 | 13.88 | 5 |
| YOLO26m / 640 | PyTorch CUDA | 8.57 | 14.92 | 5 |
| YOLO26n / 640 | ONNX CUDA | 6.49 | 14.47 | 5 |
| YOLO26s / 640 | ONNX CUDA | 8.78 | 15.31 | 5 |
| YOLO26m / 640 | ONNX CUDA | 16.48 | 23.48 | 5 |

The JSON contains per-stage medians/p95, warmup duration, exact artifact hashes and detections. Its `vramAllocatedMiB` field measures **Torch-managed allocations only**, not total ORT/native/process VRAM. The GPU capacity is known; isolated peak process VRAM remains unmeasured. Throughput derived from worker time is a repeated-photo processing rate, not phone FPS or public-relay throughput.

Small offers almost the same measured worker cost as nano here. Medium found no additional relevant object on this fixture, so there is no observed difficult-object improvement justifying making it the default. Fast/balanced/quality names map to the three actually tested sizes; neither model-size labels nor scores establish accuracy.

## Correctness, provenance and limits

All three official checkpoints came from Ultralytics' v8.4.0 asset release, retain AGPL-3.0 provenance in `worker/model-catalog.json`, and are hash checked before loading. Checkpoints and generated large local artifacts are caches, not public website assets. The 640 ONNX manifests record actual `images [1,3,640,640]` FP32 and `output0 [1,300,6]` xyxy/score/class semantics. Export used fixed batch one, opset17, dynamic=false, simplify=false, nms=false; the deprecated half=false argument still produced actual FP32. The PyTorch adapter explicitly selects the verified one-to-one head before fusing, matching the exporter.

RGB preprocessing uses a fixed square with 114 padding and aspect-preserving OpenCV bilinear resize, records actual rounded dimensions/padding, then inverts/normalizes coordinates. It maps only COCO person/bicycle/car/motorcycle/bus/truck. The 0.10 detection floor preserves the existing tracker's low-score recovery; no class-specific threshold was invented. The viewer receives semantic fields only.

The fixture is `tests/fixtures/bus.jpg` (SHA-256 `c02019c4979c191eb739ddd944445ef408dad5679acab6fd520ef9d434bfbc63`), the permitted upstream bus photo already documented in the project. All candidates detected one bus and four people. Actual PyTorch/ONNX comparisons for n/s/m passed matching semantic count, IoU >0.99 and score delta <0.005. This is one photo, not a labeled traffic corpus. Far vehicles, motorcycles, dense occlusion, lighting/motion blur, temporal identity switches and field-speed accuracy remain unmeasured. No training or new dataset download occurred.

## TensorRT outcome

[NVIDIA's version-specific 10.13.3 notes](https://docs.nvidia.com/deeplearning/tensorrt/10.x.x/getting-started/release-notes-10/10.13.3.html) describe CUDA13 support and Python3.13 bindings (not all samples). TensorRT11 uses strongly typed conversion and additional FP16 export dependencies in [current Ultralytics guidance](https://docs.ultralytics.com/integrations/tensorrt/); this bounded experiment used the inspected 10.13.3 API and CUDA13 wheel instead of changing the machine stack.

Native TensorRT imported and began a YOLO26n FP16 build with a 2GiB workspace and optimization level3. After five minutes no engine had been produced; the experiment stopped its own two Python processes. **TensorRT inference/latency/parity: NOT VERIFIED. No TensorRT model is selected and no engine is rebuilt during normal startup.** The optional preparation command now runs builders in a child process with a 300-second deadline, terminates only its own builder process tree, and reports failure. Engine runtime code validates GPU/runtime/hash metadata and refuses missing/incompatible artifacts. It remains an unverified optional path, not a claimed optimization.

## Executed tests

```powershell
worker/.venv/Scripts/python -m pytest worker/tests/test_detector_gpu.py -q
worker/.venv/Scripts/python -m pip check
worker/.venv/Scripts/python -m compileall -q worker/vision worker/runtime
```

**8 passed**: five JPEG/preprocessing/decoder rejection tests plus three actual CUDA model/parity tests (six model/runtime combinations). No CUDA test was skipped on this machine. Dependency consistency and compilation passed. An additional `worker/.venv/Scripts/python -m pytest worker/tests/test_detector_prepare.py -q` passed 1/1: a fresh empty model cache bootstraps from an external pinned catalog and reuses cached files. That regression explicitly simulates checkpoint download/export and is not CUDA proof. Worker protocol/E2E/physical-phone/cloud results belong to their separate reports; this benchmark does not imply those gates passed.

Preparation is explicit: `python -m worker.runtime.prepare` verifies/downloads the three bounded official checkpoints and exports missing fixed ONNX assets. `--build-tensorrt` is optional and may hit the documented build deadline. Normal Detector initialization only loads existing hash-verified assets; `.warmup()` must succeed before ready, and failures never switch Python inference to CPU.
