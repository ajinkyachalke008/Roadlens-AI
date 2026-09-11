# RoadLens

[Open the deployed camera app](https://roadlens-ai-five.vercel.app) · [Source](https://github.com/kokoc30/roadlens-ai)

The public frontend currently supports camera/replay analysis and local reports. Remote sharing is disabled until a Render workspace meets the required no-overage condition.

Temporary traffic monitoring from a camera browser. React + TypeScript + Vite runs genuine YOLO26n detection through an ONNX Runtime Web worker. A small Node + Express + ws process pairs devices and relays sampled analyzed images. The phone performs inference, tracking, geometry and rules; the relay is neither an AI server nor a database.

Video comes first, metrics and temporary reports below. Start a rear camera or select a permitted replay. Connect another browser using a random expiring code. Replay remains labeled and runs actual inference. The viewer does not load a detector or request a camera.

## Local setup

Node24 LTS (tested24.13.0), npm11.6.2. The two verified ONNX artifacts are included; Python is unnecessary for the pretrained app.

```powershell
npm ci
npm run model:prepare
npm run dev
```

Open http://127.0.0.1:5173 in two desktop browsers. Choose Start camera, or Settings → Use replay video. Share camera creates a code for Connect to camera. A local development URL is not a public phone deployment.

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
```

The real-model browser tests use a permitted official sample photograph with recorded provenance. They prove execution and reference parity, not field detection quality. Exact results and external gates are in [the handoff](docs/FINAL_HANDOFF.md).

## Pairing and privacy

Eight Crockford Base32 characters, displayed XXXX-XXXX, invite viewers for ten minutes. Rooms last at most sixty minutes, with one camera and two viewers. Independent automatic capabilities live only in RAM. Exact origins, role checks, schemas, rate limits and byte caps protect the relay. No login, database, cloud report storage or server inference.

Reports are limited to200; optional evidence starts off and is capped at20 images/8MiB. No application localStorage, sessionStorage, IndexedDB, service-worker cache or disk media. Reload loses page state. Pause invalidates measurement continuity; Stop sharing can keep camera-local reports; End session clears the session. Explicit JSON/CSV/image downloads are user-owned files and cannot be revoked, nor can screenshots.

Remote updates default to1Hz (maximum2), JPEG long edge640px, hard cap128KiB. Images and metadata describe the same completed frame. Slow consumers drop preview work. No viewers means no image uploads. Bandwidth limits are application limits, not a provider billing guarantee.

## Model and speed limitations

Official YOLO26n fixed FP32 ONNX profiles416 and320 use matching ORT1.29.0 single-thread WASM assets. The measured adaptive policy can downshift to320 and reduce analysis frequency. Only person, bicycle, car, motorcycle, bus and truck are mapped. See [model provenance and validation](docs/MODEL_VALIDATION.md) and public model manifests for hashes, byte sizes and export semantics.

The implemented tracker is time_aware_iou_v1, inspired by ByteTrack; it is not an official ByteTrack port. Numeric speed requires measured planar calibration, an independent check, a stationary background, stable identity and sufficient actual source-time observations. Otherwise speed is null/“—”. Persistence and episode deduplication gate speed candidates. Entered limits and margins are demo settings. Candidates are for human review, never automated legal citations. Field-speed accuracy and physical-phone performance remain unverified until measured.

Plate recognition and wrong-way alerts are disabled. No custom training ran. [Optional local training tools](training/README.md) do not block use of the pretrained application.

## Hosting and release

[Vercel static frontend + Render Free relay](docs/DEPLOYMENT.md), or the documented single-Render fallback. WebSockets and inference are not Vercel Functions. No development computer is needed at runtime after a complete deployment. Exact status, URLs and remaining account restrictions are recorded in [FINAL_HANDOFF.md](docs/FINAL_HANDOFF.md). A frontend-only release explicitly disables sharing.

The application is released under [AGPL-3.0](LICENSE), with [third-party notices](THIRD_PARTY_NOTICES.md). Public source includes the application, build scripts, tests and model provenance. Private instruction/research packs, credentials, datasets and generated captures are excluded.
