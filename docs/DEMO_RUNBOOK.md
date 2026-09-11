# RoadLens demo runbook

See FINAL_HANDOFF.md for verified URLs and release status. Full two-device cloud operation requires an authorized deployed relay; a frontend-only release explicitly disables sharing.

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

The phone runs inference; the relay only forwards bounded sampled updates. There are no end-user accounts or cloud report database. Candidates require human review and are not legal citations.
