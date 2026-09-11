# RoadLens final release handoff

## Release status

Core implementation is present and locally verified: browser YOLO inference, camera/replay, tracking, code-paired viewer, sampled frames, temporary reports/review/downloads and qualified-speed logic. Final release retesting PASSED and is recorded in RELEASE_RESULTS.md. Cloud and physical verification are separate gates; no unrun layer inherits another layer's PASS.

## Git

Branch main; application-only AGPL-3.0 release authorized. Original instructions/research/private environments and generated captures remain excluded and preserved locally. Public repository: https://github.com/kokoc30/roadlens-ai. Application release commit: c1f32553509918fae55a9eea86a78f06f8ab9099. Subsequent documentation and smoke-test changes are visible through git log; the application source is unchanged. No existing Git history was rewritten. Gitleaks8.30.1 found no secrets in the release preparation scan.

## Deployment

Frontend production URL: https://roadlens-ai-five.vercel.app. Vercel project roadlens-ai is deployed on Hobby. The dashboard verified Ready/Production, source c1f32553509918fae55a9eea86a78f06f8ab9099,18second build, and19 static assets with no functions. This is a frontend-only release while the relay is blocked. That build explicitly sets VITE_SHARING_DISABLED=true; camera/replay analysis and local reports remain available, Share/Connect do not claim availability.

Render Free relay creation is BLOCKED by the user's strict no-overage condition: the authorized account explicitly bills usage beyond its included allowances. No cloud relay exists and no billing settings were changed. Full cloud smoke/deployed restart remain NOT RUN. Public frontend smoke PASSED1/1 in9.2seconds: actual416 and320 browser inference, profile-reset provenance, local observation/JSON/CSV, cleanup, no API requests, no viewer model/camera and no browser console/page errors. HTTPS, model/runtime MIME and source-pinned bytes/hashes, and missing-asset404s passed. Local development/relay ports were not listening. Full cloud smoke remains NOT RUN.

## Tests

The clean baseline passed every documented command. Release changes have passed fresh npm ci/model preparation/typecheck/lint;173 combined tests (106 unit,34 contracts,33 real relay),11 browser-model tests,21 synthetic training safeguards and deployment schemas. Final cold-force E2E/privacy9/9 passed in1.4minutes, production build passed, model11/11 in6.7seconds, compiled same-origin paired1/1 in11.8seconds, and split-origin HTTPS/WSS paired1/1 passed.

The106 unit tests include51 measurement/geometry/tracking/rule tests,32 report/session tests,11 transport/lifecycle tests,8 inference safety tests and4 adaptive/unit-conversion tests. Numerical motion and texture fixtures are synthetic tests, not field accuracy. The browser replay fixture uses a permitted actual photograph and executes the real model, not prerecorded detection JSON. Native camera tests use explicitly simulated Chromium devices, not physical phones.

## Model

Official YOLO26n; fixed FP32 ONNX416 and320. Input images [1,3,S,S], inspected output output0 [1,300,6] xyxy/score/class rows. RGB letterboxing and inverse coordinates are explicit; unknown semantics fail. Correct pretrained COCO mappings expose person/bicycle/car/motorcycle/bus/truck. Runtime ONNX Runtime Web1.29.0, single-thread WASM, matching public JS/WASM assets. WebGPU is not enabled.

| Profile | Bytes | SHA-256 |
|---|---:|---|
|416|9,796,924|703143276b5c7c32c18299510f490b3079e256fbd7866d891a1ef030a640ea21|
|320|9,767,944|3462385c62a59f028a400b71ecfa200c53880854f2e5078b73edb3c536d1ba02|

Export: Ultralytics8.4.146, Torch2.14.0+cpu, ONNX1.20.1, Python3.13.12. The primary model worked; no unverified fallback was substituted. Both graph/runtime bytes are pinned. See MODEL_VALIDATION.md and public manifests for provenance/licenses. The final desktop run at02:06:17Z measured97.1–98.2ms for416 and71–78.6ms for320 on the two photo shapes. These are variable single-image desktop timings, not sustained phone benchmarks.

## Implemented behavior

The phone owns inference, time_aware_iou_v1 tracking, geometry, policy and report state. The tracker is ByteTrack-inspired, not an official port. Present counts use observed objects; optional crossing logic is module-tested but no line-drawing UI is claimed. A measured adaptive controller can downshift416→320 and reduce analysis rate; capture uses one active job and newest useful input.

Eight-character Crockford invitations expire after10minutes; rooms after60minutes. One owner/two viewers use independent automatic RAM capabilities and exact-origin role-bound sockets. No viewer model/camera, public room directory, database, durable history or cloud inference exists. Owner can rotate, revoke or end sharing. Camera resynchronizes reports after reconnect. The relay stores bounded membership/rate/correlation metadata and transit queues, no report or latest-frame repository.

Remote JPEG updates default1Hz/max2, long edge640px, target80KiB/hard128KiB. Exact completed images and metadata stay together. No viewers means no image upload; slow sockets drop preview work. Room128MiB/process-boot256MiB limits include fanout content and are not provider billing guarantees.

Reports are bounded200; optional evidence starts off, max20 images/8MiB. Tracking holds max100 identities/32 observations each. Reports can be saved with null speed. Source-authoritative reviews, explicit JSON/CSV/image downloads, evidence eviction and source revision checks are implemented. Detector score is not speed accuracy or violation probability.

Pause stops media and invalidates measurement continuity. Stop sharing can preserve camera-local reports. End/pagehide/BFCache cleanup releases media, workers, sockets, evidence and relevant settings. Reload loses RAM. Downloads/screenshots cannot be revoked. No app localStorage/sessionStorage/IndexedDB/Cache Storage, disk uploads or content logging is used.

## Speed

Calibrated-speed logic is tested. Numeric estimates require a fixed approximately planar measured setup, independent calibration check, stationary background, stable identity, at least8 qualified actual observations over1.5s, at least4Hz, gaps≤350ms, displacement≥3m and residual/direction gates. Unverified samples cannot later enter speed history. Invalid states remain null/“—”. Demo limits/margins support mph/km/h; persistence/hysteresis and episode dedup gate review candidates. No fines, government reporting or legal-admissibility claim.

Real-field speed accuracy: UNMEASURED. No independent ground-truth trial; MAE/median/max error unavailable. The safe prepared field protocol in MEASUREMENT_RELEASE_AUDIT.md records all attempted passes and unavailable coverage, without unsafe driving.

## Optional features

Plates: DISABLED. No verified browser plate detector/OCR assets, consented evaluation or phone-budget result. No invented plate text or paid API.

Wrong-way: DISABLED. No complete direction policy/drawer/producer or controlled trajectory validation; an enum alone is not implementation. Adding it now would expand release scope beyond verified behavior.

Training: NOT RUN.21 synthetic dataset/resume/promotion safeguards pass. Pretrained app is independent of Python. GPU preflight found a local NVIDIA GPU but the isolated export environment is CPU-only; no driver or global configuration changes. Custom staged-model promotion remains unused and requires matching real browser and physical-phone evidence.

## Physical phone

NOT VERIFIED. No physical rear-camera/cellular/second-network, sustained thermal/memory or permission-background trial occurred. Desktop mobile widths360/390/430 and1440px are automated layout checks only. Use DEMO_RUNBOOK.md for the concise device checklist.

## Demo and remaining actions

Local paired demo: npm ci; npm run model:prepare; npm run dev. Open http://127.0.0.1:5173 in two desktop browsers. Use a camera or permitted Settings → Use replay video; Share/connect by code, save/review/export, Stop sharing/re-pair, End and verify cleanup.

Public camera-only demo: open https://roadlens-ai-five.vercel.app, choose Start camera or Settings → Use replay video, save observations and explicitly download reports. Sharing is unavailable. For full cloud: provide an authorized Render workspace with verified no-overage behavior; deploy render.yaml free relay; configure exact frontend ALLOWED_ORIGINS and Vercel HTTPS VITE_API_BASE_URL plus VITE_SHARING_DISABLED=false; rebuild; run smoke:cloud with actual origins; verify real relay restart; stop local services; execute the physical phone checklist. Then perform safe independent field-speed evaluation if needed.
