# RoadLens

[Open the deployed camera app](https://roadlens-ai-five.vercel.app) · [Source](https://github.com/kokoc30/roadlens-ai)

The public frontend supports camera/replay analysis, local reports and remote sharing through the deployed Render relay. Full cloud pairing is verified: the real paired browser flow passes against the deployed frontend and relay together.

Temporary traffic monitoring with browser inference and an optional local NVIDIA GPU worker. React + TypeScript + Vite retains genuine YOLO26n ONNX Runtime Web fallback. The optional Windows worker runs YOLO26s640 on CUDA and connects outward to the Node/Express/ws relay. The phone remains authoritative for tracking, geometry, rules and reports; the relay only pairs and forwards bounded data.

Video comes first, metrics and temporary reports below. Start a rear camera or select a permitted replay. Connect another browser using a random expiring code. Replay remains labeled and runs actual inference. The viewer does not load a detector or request a camera.

## Local setup

Node24 LTS (tested24.13.0), npm11.6.2. The two verified ONNX artifacts are included; Python is unnecessary for the pretrained app.

```powershell
npm ci
npm run model:prepare
npm run dev
```

Open http://127.0.0.1:5173 in two desktop browsers. Choose Start camera, or Settings → Use replay video. Share camera creates a code for Connect to camera. A local development URL is not a public phone deployment.

## Optional GPU setup

```powershell
# First setup only: isolated Python 3.13, pinned packages and cached models.
.\setup-worker.ps1 -PythonExecutable python
# Configure ignored .env.worker with actual relay WSS URL and machine secret.
# Normal operation; Ctrl+C stops this foreground worker.
.\start.ps1
```

GPU startup never installs packages or rebuilds an engine. The selected verified runtime is PyTorch CUDA; ONNX CUDA also passes real parity. TensorRT did not complete its bounded build and is unverified. See [GPU setup/protocol](docs/GPU_WORKER.md) and [actual benchmarks](docs/GPU_BENCHMARK.md). No Python CPU fallback, inbound port or tunnel is used. Cloud GPU operation is blocked until the authorized relay exists; browser fallback remains independent of the GPU computer.

## Verification

Run browser suites sequentially:

```powershell
npm run typecheck
npm run lint
npm run test:unit
npm run test:contracts
npm run test:integration
npx playwright install chromium
npm run test:model
npm run test:e2e
npm run test:privacy
npm run build
npm run test:production
npm run test:split-production
npm run deploy:verify
# With worker setup completed on the NVIDIA machine:
npm run test:worker
npm run test:start
npm run test:gpu
npm run gpu:benchmark
```

The real-model browser tests use a permitted official sample photograph with recorded provenance. They prove execution and reference parity, not field detection quality. Exact results and external gates are in [the handoff](docs/FINAL_HANDOFF.md).

## Pairing and privacy

Eight Crockford Base32 characters, displayed XXXX-XXXX, invite viewers for ten minutes. Rooms last at most sixty minutes, with one camera and two viewers. Independent automatic capabilities live only in RAM. Exact origins, role checks, schemas, rate limits and byte caps protect the relay. No login, database, cloud report storage or server inference.

Reports are limited to200; optional evidence starts off and is capped at20 images/8MiB. No application localStorage, sessionStorage, IndexedDB, service-worker cache or disk media. Reload loses page state. Pause invalidates measurement continuity; Stop sharing can keep camera-local reports; End session clears the session. Explicit JSON/CSV/image downloads are user-owned files and cannot be revoked, nor can screenshots.

Viewer updates default to1Hz (maximum2), JPEG long edge640px, hard cap128KiB. GPU analysis is a separate bounded stream, default640long edge, at most15Hz and at most two in-flight frames, with optional960 encoding. Images and metadata describe the same completed frame. Slow consumers drop work. No viewers means no preview upload; enabled GPU analysis still sends images to the worker. All relay egress joins existing room/process caps, which are application limits rather than provider billing guarantees.

## Model and speed limitations

Official YOLO26n fixed FP32 ONNX profiles416 and320 use matching ORT1.29.0 single-thread WASM assets. The measured adaptive policy can downshift to320 and reduce analysis frequency. Only person, bicycle, car, motorcycle, bus and truck are mapped. See [model provenance and validation](docs/MODEL_VALIDATION.md) and public model manifests for hashes, byte sizes and export semantics.

The implemented tracker is time_aware_iou_v1, inspired by ByteTrack; it is not an official ByteTrack port. Numeric speed requires measured planar calibration, an independent check, a stationary background, stable identity and sufficient actual source-time observations. Otherwise speed is null/“—”. An accepted calibration is graded Valid or Weak, and a Weak grade names the marginal property. Speed validation tooling records measured-versus-reference trials and computes MAE, median, p95, maximum and signed bias; [the procedure and the empty results table](docs/SPEED_VALIDATION.md) make clear that no physical field accuracy has been measured yet. Persistence and episode deduplication gate speed candidates. Entered limits and margins are demo settings. Candidates are for human review, never automated legal citations. Field-speed accuracy and physical-phone performance remain unverified until measured.

Plate recognition and wrong-way alerts are disabled. No custom training ran. [Optional local training tools](training/README.md) do not block use of the pretrained application.

## Hosting and release

[Vercel static frontend + Render Free relay](docs/DEPLOYMENT.md), or the documented single-Render fallback. WebSockets and inference are not Vercel Functions. Browser mode needs no development computer after deployment; optional GPU mode needs the Windows worker running. Exact status, URLs and remaining account restrictions are recorded in [FINAL_HANDOFF.md](docs/FINAL_HANDOFF.md). A frontend-only release explicitly disables sharing and GPU transport.

The application is released under [AGPL-3.0](LICENSE), with [third-party notices](THIRD_PARTY_NOTICES.md). Public source includes the application, build scripts, tests and model provenance. Private instruction/research packs, credentials, datasets and generated captures are excluded.
