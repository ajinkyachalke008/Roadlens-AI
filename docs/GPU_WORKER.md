# Optional local GPU worker

The September 2026 GPU request replaces the older prohibition on a local inference computer. The public frontend retains browser YOLO26n WASM. Optional GPU mode needs the user's Windows NVIDIA computer running; it connects **outbound** to the RAM relay. No inbound port, tunnel, Python cloud process, neural relay dependency or database exists.

## Setup and normal operation

```powershell
# One-time, project-isolated setup. Tested Python 3.13.12.
.\setup-worker.ps1 -PythonExecutable python

# After configuring the ignored .env.worker:
.\start.ps1
```

The setup script creates worker/.venv, installs pinned Windows dependencies, prepares hash-verified official checkpoints and fixed640 ONNX artifacts, runs worker tests including actual CUDA parity, and writes a bounded benchmark. It does not train or download datasets. Normal start validates the environment/configuration, checks actual CUDA execution, verifies a cached artifact, warms the model and connects to the relay. It does not install packages or export/build engines. Ctrl+C stops the foreground worker; there is no process-name kill script or unrelated-process cleanup.

Copy `.env.worker.example` to `.env.worker` if setup has not created it. Set ROADLENS_RELAY_URL to the actual deployed `wss://<relay-origin>/worker`, and set the same ROADLENS_WORKER_SECRET only in that file and the backend environment. Generate32 random bytes encoded as43 unpadded base64url characters; for example:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Copy the generated secret privately. Do not put it in Vercel, a URL, a shell history command argument or Git. The frontend uses only automatic room capabilities in RAM. There is no user account or login UI. The example contains no usable secret. `.env.worker`, model caches, Python environments, generated engines and Ultralytics project settings are ignored.

Defaults: ROADLENS_MODEL_MODE=balanced, ROADLENS_GPU_RUNTIME=pytorch_cuda, ROADLENS_GPU_DEVICE=0, ALLOW_WORKER_CPU_FALLBACK=false. Fast/balanced/quality map to tested YOLO26n/s/m640. All numeric inference uses GPU; Python CPU fallback is deliberately unsupported. The UI may use its existing browser WASM detector instead. ONNX CUDA is also tested; TensorRT did not finish the bounded engine build and remains unverified/unselected.

## Verified runtime

RTX5070Ti16GiB, driver610.74, compute12.0; system toolkit13.0.48. Isolated Torch2.14.0+cu130, torchvision0.29.0+cu130, cuDNN9.24, Ultralytics8.4.146, ONNX Runtime GPU1.29.0, websockets17.0.1. Exact transitive dependencies are pinned in worker/requirements.txt. See GPU_BENCHMARK.md for current compatibility sources, actual GPU node-placement proof, artifact hashes, performance and limitations.

The source-controlled worker/model-catalog.json pins official checkpoint URLs, licenses, sizes and SHA-256. Setup can recreate an empty model cache. Generated ONNX/engine metadata stays beside the local artifact; every load validates size/hash/graph shape. Browser assets and their independent parity tests are unchanged.

## Actual data path and ownership

On an explicit camera/replay start, an enabled frontend makes one bounded status request. If the worker is ready it creates a normal temporary room, completes the owner handshake, then requests the GPU lease. Otherwise browser inference starts. Settings supports explicit GPU retry and browser selection; there is no silent mid-trajectory return to GPU after a disconnection.

The phone retains one active captured canvas and the latest completed analyzed canvas. It sends a compressed JPEG of that active canvas. The result must match room, source, capture epoch, sequence, source time and dimensions exactly before it can render. Timed-out, malformed, duplicate or unrelated results cannot reuse a different image. Overlays, evidence and reports use the completed frame. Replay remains visibly labeled and preserves media time.

The GPU runs the neural detector. The existing camera-side time_aware_iou_v1 tracker, background guard, calibration, speed estimator, rules and report revision serializer remain authoritative. This preserves the tested scientific logic and avoids duplicate cross-language trajectories. GPU detection still increases the available actual observation rate. Cheap tracking does not need GPU execution. It is not advertised as an official ByteTrack port.

Switching runtime, worker loss, pause, seek, source geometry change or end resets the relevant capture epoch, tracks, calibration and rule continuity. GPU loss automatically loads and runs the browser detector. Stop sharing releases GPU access and falls back locally while preserving reports; End clears reports and resources. Worker disconnect/reconnect does not revive old room capabilities after a relay restart.

## Protocol and bounds

Shared implementation: shared/src/gpu.ts and GPU_LIMITS in shared/src/limits.ts; Python validates the same fields independently.

| Surface | Contract |
|---|---|
| /worker | Non-browser outbound WSS, no Origin, first worker.register v1 with role worker, machine secret and workerVersion1; registration acknowledgement includes relay epoch. |
| /gpu | Exact browser Origin; first gpu.hello v1 with role camera, existing roomId/owner capability. The original /ws owner must already be connected. Viewer capabilities cannot acquire the lease. |
| worker.ready | Sent only after actual cached model load/GPU warmup; exact model ID/hash/runtime/input640. Public status exposes only enabled/ready/offline/busy; authenticated camera receives model provenance. |
| camera.frame | Binary RLG1 magic, four-byte big-endian UTF8 header length, strict v1 header, JPEG bytes. No base64. Source dimensions, encoded dimensions, sourceTimeMs and epoch:sequence frameId are mandatory. |
| inference.result | Same complete identity/dimensions, semantic six-class detections and model/timing metadata. No camera/report-policy mutation. |
| camera.cancel | Retires current identity. An already executing native job may finish; its result is discarded by the relay before another lease is allowed. |
| heartbeat | Worker15s heartbeat/45s deadline; camera nonce echo measures same-clock relay RTT. No one-way cross-device subtraction. |

One worker, one active camera lease, one in-flight inference and no application waiting queue. Camera sampling starts at10Hz and adapts within the15Hz hard maximum using measured encode/result cycle time. Busy source callbacks are skipped; socket congestion never grows an inference backlog. Analysis JPEG default long edge640, optional960, target80KiB/hard192KiB; header4096bytes, binary256KiB, JSON32KiB, two-second result deadline. JPEG SOF dimensions are checked before relay forwarding and worker pixel decoding. Source dimensions are bounded8192per axis/16,777,216pixels; aspect ratio is preserved.

Viewer RLN2 preview remains default1Hz/max2,640long edge/128KiB. With no viewers no preview image is uploaded, but explicitly enabled GPU analysis still sends frames to the worker. All worker frame/result egress joins the same128MiB room/256MiB process-boot budget, including fanout. Exhaustion stops sharing visibly. These limits are not a provider billing guarantee.

The relay stores bounded memberships, correlation identities, rate limits and transit buffers only. The worker has one transient JPEG/tensor/result, no media/report archive. Worker logs contain categorical status and model/runtime diagnostics, never codes, capabilities, images, report facts or plate text. The only deliberate persistent outputs are model/engine caches, explicit benchmark/test artifacts and user report downloads. Reports/evidence remain bounded camera/viewer RAM.

## Verification and troubleshooting

```powershell
npm run test:worker
npm run gpu:benchmark
npm run build
npm run test:gpu
```

test:gpu starts and stops its own compiled loopback relay and real CUDA worker, runs a permitted photo-backed replay through the actual browser→relay→GPU→browser path, and tests viewer/report/fallback/restart behavior. Loopback ws is permitted only with explicit ROADLENS_ALLOW_LOOPBACK=true in that isolated test. Public worker configuration requires WSS. Automated loopback and desktop viewport tests are not physical-phone or production-network evidence.

If start reports missing environment/artifact, run setup once. If NVIDIA initialization fails, run `worker/.venv/Scripts/python -m worker.runtime.gpu`; do not enable CPU fallback or randomly replace drivers. If registration fails, verify the exact /worker WSS URL and matching machine secret privately. If busy, pause/end the other camera lease. If the relay restarts, the worker reconnects automatically with bounded exponential backoff; create a new camera room/code. Recalibrate after runtime/source changes before expecting any numeric speed.

Cloud GPU transport currently requires the blocked Render deployment. The existing public Vercel app remains frontend-only with sharing disabled until a workspace satisfies the previously authorized no-overage condition. No production GPU connection or physical phone success is implied by local tests. See FINAL_HANDOFF.md for executed gates.
