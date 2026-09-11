# Third-party notices

- Official Ultralytics YOLO26n checkpoint and derived ONNX weights: AGPL-3.0; preserved full upstream license and provenance in `frontend/public/models/`. No enterprise license purchased. The released RoadLens application source is under AGPL-3.0 (see LICENSE). Original private instruction/research packs are excluded and retain their existing ownership.
- Optional worker YOLO26n/s/m checkpoints: same official publisher AGPL-3.0 terms; source URLs, byte sizes and hashes are pinned in worker/model-catalog.json. Setup downloads these into ignored local model caches. Generated CUDA ONNX/optional TensorRT manifests bind the source hash and actual runtime. No custom model training occurred.
- PyTorch/torchvision, ONNX Runtime GPU, websockets, Pillow/OpenCV and worker dependencies retain their respective publisher licenses; exact Windows versions are pinned in worker/requirements.txt. NVIDIA CUDA/cuDNN/TensorRT retain NVIDIA's licensing terms; optional TensorRT packages are isolated in a separate requirements file and are not redistributed as a verified engine.
- ONNX Runtime Web1.29.0: MIT; exact runtime notices and SHA-256 manifest in `frontend/public/ort/`.
- Official Ultralytics sample bus photo and PNG derivatives: source, original hash and license recorded in `tests/fixtures/provenance.json`. These are automated evaluation assets, not live road footage or broad detector accuracy evidence.
- `time_aware_iou_v1` is a newly implemented ByteTrack-inspired time-aware tracker. It is not advertised as an official ByteTrack port. Hungarian assignment and geometry code are locally implemented using `ml-matrix` SVD; dependency notices remain in installed packages.
- React, Vite, Express, ws, zod, ml-matrix and development tools retain their own publisher licenses. Exact packages are locked by `package-lock.json`.

Corresponding application source, build configuration, tests and model manifests are released together. Public model files preserve their publisher notices. Generated runtime files are reproducible from the exact npm lock and retain the matching MIT notice.
