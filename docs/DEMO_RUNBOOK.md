# RoadLens demo runbook

## GPU demonstration

Current cloud GPU path is blocked by the undeployed Render relay. Once that deployment is authorized and verified:

1. Complete .\setup-worker.ps1 once, then configure the actual WSS relay and matching private machine secret in ignored .env.worker.
2. Run .\start.ps1 on the NVIDIA computer; wait for verified GPU warmup and authenticated relay readiness. Keep this worker running, but stop local development servers.
3. Open the verified public Vercel camera URL on the phone. Start camera; confirm GPU AI Online and real returning detections. Sharing uses the existing temporary code. Connect the second device and save/review/export an observation.
4. Pause/resume or switch Settings → Use browser AI. Each switch clears measurement continuity. Stop the worker to demonstrate actual automatic WASM fallback; restart it and explicitly choose Use GPU worker to return safely.
5. End session and confirm views/reports clear; Ctrl+C stops the foreground worker. Downloaded files/screenshots cannot be revoked.

For the verified automated local GPU path, run npm run build followed by npm run test:gpu after worker setup. It uses actual CUDA with a clearly labeled still-photo replay; it is not real traffic motion, a physical phone or cloud evidence. Detailed runtime/transport metrics are in the settings drawer and generated local test artifacts.

Physical GPU checklist: phone on cellular, viewer on a second network; record source dimensions,640/960 analysis encoding, actual submission/resultHz, same-clock age/RTT, worker runtime and measured inference, GPU failure/recovery, permission/background behavior and end cleanup. The phone does not request a microphone, and the worker computer requires no inbound port. All such physical checks remain NOT VERIFIED until executed.

Verified public frontend: https://roadlens-ai-five.vercel.app. See FINAL_HANDOFF.md for release status. Full two-device cloud operation requires an authorized deployed relay; a frontend-only release explicitly disables sharing.

## Local paired demonstration

```powershell
npm ci
npm run model:prepare
npm run dev
```

Open http://127.0.0.1:5173 in two desktop browsers. Choose Start camera, or Settings → Use replay video with a permitted clip. Replay runs the actual model and stays labeled. Share camera displays a temporary code; the second browser chooses Connect to camera. Save an observation, review it from the viewer, download JSON/CSV, then End session and verify cleanup. Evidence starts off; enable it explicitly before saving an image. Pause resets measurement continuity. Stop sharing preserves camera-local reports for re-pairing.

For repeatable automated evidence, run npm run test:e2e. After npm run build, npm run test:production exercises the compiled single-process deployment locally. Tests start and stop their own services. The image-backed replay fixture proves real inference/integration, not real traffic motion or accuracy.

## Public camera-only demonstration

At the verified frontend URL choose Start camera and grant camera-only permission. Settings also supports a permitted replay, profile choice, demo policy and optional evidence. Show genuine detections and temporary observations below the image. Sharing/Connect remain visibly unavailable until an authorized relay exists. Do not describe this mode as a completed remote-viewing deployment.

## Physical-device checklist — NOT YET EXECUTED

After both public deployments and cloud smoke pass, stop all local services. Use a physical phone on cellular and a viewer on another network. Record phone model, OS, browser, profile, actual analysisHz/previewHz/processing time, permission behavior, thermal/memory symptoms and network failures.

1. Load public HTTPS site; Start camera; confirm rear camera and no microphone request.
2. Verify model loads and real detections/IDs appear. Test416 and320, and record measured rates.
3. Share; connect the second device by code; inspect matching analyzed frame/boxes and metrics.
4. Save an observation; review Noted/Dismissed from viewer; export JSON/CSV and optional image.
5. Pause/resume, switch replay/camera, rotate, background/restore and test permission loss. Old speed/frames must not reappear as current.
6. Stop sharing; confirm camera reports remain and viewer clears; create a new code and reconnect.
7. Restart the deployed relay safely; old pairing must fail, still-open camera reports remain, new pairing resynchronizes.
8. End session; verify media/worker/socket release and both pages clear. Reload loses RAM. Downloads/screenshots cannot be revoked.

## Speed demonstration and field evaluation

Handheld/uncalibrated operation stays detection-only with speed “—”. For numeric speed, mount the camera rigidly, measure a planar road zone and calibration references, pass an independent check, confirm stationary background and sufficient observed source-time samples, then enter an explicitly labeled demo speed limit/margin. Do not relax gates or promise an event on a slow phone.

Use a safe controlled permitted site and independent speed reference. Never ask anyone to speed, drive the wrong way or perform a dangerous maneuver. A low artificial demo threshold can exercise a candidate safely. Record all attempted passes, null outcomes, reference uncertainty, matched estimates and configuration versions. Calculate absolute errors, MAE, median and maximum error only for valid matched passes, alongside unavailable coverage. The detailed prepared protocol is in MEASUREMENT_RELEASE_AUDIT.md. Until executed, field accuracy is UNMEASURED.

## Honest fallbacks

- Slow device: measured automatic320 fallback/reduced analysis rate; no fabricated FPS or speed.
- No useful live scene: permitted Replay with real inference.
- Relay unavailable/budget exhausted: local analysis and reports; explicitly unavailable remote view.
- Invalid calibration/background/tracking: null speed; save a genuine observation.
- Optional plates/wrong-way: disabled, never fabricated.

Browser mode runs inference on the phone; optional GPU mode forwards bounded analysis images to the user's outbound worker. The relay runs no model. There are no end-user accounts or cloud report database. Candidates require human review and are not legal citations.
