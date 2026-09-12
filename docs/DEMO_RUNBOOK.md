# RoadLens demo runbook

## Adaptive Showcase and plate behavior

Showcase now requests a 1920×1080/30 ideal camera profile and displays the
actual browser-selected width, height and frame rate. It arms after four seconds
of analyzed source time, but does not fire on that clock alone. RoadLens finds a
stable eligible vehicle, marks it amber as **ACQUIRING**, locks that track, and
waits for better real source pixels while size, sharpness, framing, stability
and image-scale growth remain useful. The target turns red with **TRAFFIC
ALERT** only when the event report is created.

Plate acquisition begins at lock, before report creation. It can score at most
16 distinct source looks at a 320 ms cadence over 4.8 seconds, retains/submits
only the best eight, and submits one crop at a time no faster than every 600 ms.
Confirmation still requires defensible agreement across distinct frames and
stops capture early. A strong single real reading may appear as **Possible
plate · Unconfirmed**; it never becomes the confirmed plate field by itself.

Leave the report open while it says **Analyzing clearer frames…**. The separate
**Best Vehicle Capture** can improve in place, and **Best Plate Detail** appears
only after the real detector localizes a plate. The original annotated **Event
evidence** and downloaded event JPEG never change. `Plate located · text
unreadable` means localization succeeded but characters could not be defended.

End Session, pagehide, source/runtime reset, timeout or confirmation destroys
all temporary raw crops. Diagnostics expose counts, dimensions, bytes and
latency—not plate strings. Physical validation is still required before any
real-world recovery claim.

## Showcase presentation flow — September 12, 2026

Showcase is a small camera-page switch that automates one truthful presentation
event. It does not change the detector, tracker, plate reader, speed gates or
privacy model. The switch is **off by default** and its state is held only in
the camera tab's RAM.

### Before the presentation

1. Complete `./setup-worker.ps1` once on the RTX 5070 Ti computer and keep the
   real production WSS relay URL and matching secret in ignored `.env.worker`.
2. Run `./start.ps1` and wait for `GPU WORKER READY`. Do not expose an inbound
   port or start a development tunnel.
3. Open <https://roadlens-ai-five.vercel.app/camera> on the phone and confirm
   **Showcase · Off**. Open the viewer on the second device if the paired view
   is part of the presentation.
4. Keep one permitted traffic replay clip available on the phone as the
   emergency fallback. It must go through **Use replay video** and the real
   detector; prerecorded detection JSON is never allowed.

### During the presentation

1. Toggle **Showcase** on. Its compact status reads **Arming**.
2. Start the camera, keep the view steady and point it at actual traffic.
3. At four seconds of completed analyzed source time, the status moves to
   **Waiting**. It keeps waiting until a real eligible vehicle appears; the
   four-second gate is minimum arming, not an event timer.
4. RoadLens chooses one observed, non-ambiguous, confirmed car, motorcycle, bus
   or truck with sufficient confidence, duration and crop size. Plate text is
   not an input. The chosen identity turns amber with **ACQUIRING** and remains
   locked while it approaches.
5. The controller waits for the real source crop to meet its 0.68 readiness
   threshold, or uses a bounded quality/trajectory fallback before the 6.5 s
   target wait expires. It never waits beyond the overall 25 s bound and never
   switches tracks after lock; losing the target for 800 ms aborts that run and
   clears its pre-report pixels.
6. At the chosen frame, the target turns red with `TRAFFIC ALERT`, opens the
   existing Selected Vehicle card, and creates exactly one temporary report.
   In handheld mode speed remains unavailable; red means presentation target,
   not speeding.
7. Plate status and Best Vehicle Capture then continue updating in the open
   report and paired viewer. Show confirmed text only after distinct-frame
   consensus; otherwise show **Analyzing clearer frames…**, **Possible plate ·
   Unconfirmed**, **Plate located · text unreadable**, **Unreadable**, or
   **Plate unavailable** as actually supported.
8. Open the report. Its full report-time frame has a baked red box and
   `TRAFFIC ALERT · CLASS · ID` label on the exact reported vehicle. Small
   targets also receive a same-frame corner inset. The paired viewer receives
   that same annotated JPEG through the normal evidence flow, and **Download
   image** saves the same marked bytes.
9. Point out the professional details: **Trigger**, **Vehicle**, **Measurement
   mode**, **Speed status**, **Plate**, detector score, model, calibration and
   tracker. Then show the separate Best Vehicle Capture and optional Best Plate
   Detail with their real source frame, dimensions and quality. Limit and margin
   stay hidden when no limit was configured.

Showcase produces one automatic event per enabled run. Toggle it off and on to
start a fresh run. Toggle off clears the Showcase target without deleting an
already-created session report. End session, pagehide, reload or source/runtime
continuity reset clears the applicable RAM-only state and never carries a target
across capture epochs.

### Honest fallbacks

- **No eligible vehicle:** the status stays **Waiting** and then ends as **No
  vehicle** after the bounded 25-second acquisition window; no box or report is
  invented.
- **GPU unavailable:** browser WASM remains real vehicle inference, while the
  report says **Plate unavailable**.
- **Poor/short plate view:** the existing bounded plate path settles
  **Unreadable**; it never generates a sample plate.
- **No useful live scene:** use the permitted replay through the real inference
  and tracking path. The stage remains visibly labeled **REPLAY**.
- **Handheld or invalid calibration:** speed remains null. Mounted speed appears
  only if the unchanged calibration, stationary-background, sampling and rule
  gates produce a genuine speed candidate.

The automated desktop and local-CUDA paths are verified. A physical phone,
cellular/second-network run and real-road plate/speed behavior remain **NOT YET
VERIFIED** until the checklist below is executed.

### Physical iPhone acceptance procedure

1. Start the verified local NVIDIA worker and wait for `GPU WORKER READY`.
2. Open the deployed camera page on an iPhone and enable Showcase.
3. Record the requested and actual camera width, height and frame rate shown in
   Diagnostics.
4. From a legal, stationary and safe position, point the rear camera toward
   approaching traffic; test several vehicle sizes and distances.
5. Confirm RoadLens waits for a better target after minimum arming instead of
   firing only because four or five seconds elapsed.
6. Confirm the same amber target remains locked as it approaches and that the
   report is created on a clearer frame.
7. Leave the report open and observe Best Vehicle Capture and plate status
   update; verify any confirmed plate manually only where safely and legally
   visible.
8. For every attempt, record vehicle-crop dimensions, plate source-pixel
   dimensions, distinct attempts, localization/readability, final result and
   whether the visible plate matched.
9. Check the paired viewer, portrait and landscape layout, evidence/detail
   aspect ratio, and reachable close/download controls.
10. End Session and verify reports, evidence/detail images and all temporary
    plate crops disappear on both devices.

Do not claim physical improvement until this procedure is completed.

## GPU demonstration — cloud path verified

The Render relay is deployed and the full cloud path is verified: the real paired
browser flow passes against the deployed frontend and relay together, and with
the local worker connected outbound the hosted path measured 49–58 ms round
trip, 9.5–10.0 analysis Hz, 123 ms result age and 230 ms overlay age, holding
two bounded frames in flight with zero superseded and zero stale results. Rerun
that measurement any time with `npm run measure:production`.

The exact demo sequence:

1. Complete .\setup-worker.ps1 once, then configure the actual WSS relay and matching private machine secret in ignored .env.worker.
2. Run .\start.ps1 on the NVIDIA computer; wait for verified GPU warmup and authenticated relay readiness. Keep this worker running, but stop local development servers.
3. Open the verified public Vercel camera URL on the phone. Start camera; confirm GPU AI Online and real returning detections. Sharing uses the existing temporary code. Connect the second device and save/review/export an observation.
4. Pause/resume or switch Settings → Use browser AI. Each switch clears measurement continuity. Stop the worker to demonstrate actual automatic WASM fallback; restart it and explicitly choose Use GPU worker to return safely.
5. End session and confirm views/reports clear; Ctrl+C stops the foreground worker. Downloaded files/screenshots cannot be revoked.

For the verified automated local GPU path, run npm run build followed by npm run test:gpu after worker setup. It uses actual CUDA with a clearly labeled still-photo replay; it is not real traffic motion, a physical phone or cloud evidence. Detailed runtime/transport metrics are in the settings drawer and generated local test artifacts.

Physical GPU checklist: phone on cellular, viewer on a second network; record source dimensions,640/960 analysis encoding, actual submission/resultHz, same-clock age/RTT, worker runtime and measured inference, GPU failure/recovery, permission/background behavior and end cleanup. The phone does not request a microphone, and the worker computer requires no inbound port. All such physical checks remain NOT VERIFIED until executed.

Verified public frontend: https://roadlens-ai-five.vercel.app, verified relay: https://roadlens-relay.onrender.com. See FINAL_HANDOFF.md for release status. Two-device cloud operation is verified against both; the frontend-only mode, which visibly disables sharing, remains available for deployments without an authorized relay.

## Local paired demonstration

```powershell
npm ci
npm run model:prepare
npm run dev
```

Open http://127.0.0.1:5173 in two desktop browsers. Choose Start camera, or Settings → Use replay video with a permitted clip. Replay runs the actual model and stays labeled. Share camera displays a temporary code; the second browser chooses Connect to camera. Save an observation, review it from the viewer, download JSON/CSV, then End session and verify cleanup. Evidence starts off; enable it explicitly before saving an image. Pause resets measurement continuity. Stop sharing preserves camera-local reports for re-pairing.

For repeatable automated evidence, run npm run test:e2e. After npm run build, npm run test:production exercises the compiled single-process deployment locally. Tests start and stop their own services. The image-backed replay fixture proves real inference/integration, not real traffic motion or accuracy.

## Public camera-only demonstration

At the verified frontend URL choose Start camera and grant camera-only permission. Settings also supports a permitted replay, profile choice, demo policy and optional evidence. Show genuine detections and temporary observations below the image. This mode needs no relay and no GPU computer, so it is the safe fallback if either is unavailable during a demo.

## Speed validation demonstration

Only meaningful with a mounted, calibrated camera. Calibrate first and confirm
the status line reads _measured setup_ rather than _weak calibration ·
re-measure_. Open **Validate speed**, pick a vehicle that currently shows a
valid measured speed, enter the independently measured reference speed and its
method, and record the trial. The summary shows MAE, median, p95 (suppressed
below 20 trials), maximum and signed bias; export JSON or CSV before ending the
session, because End session clears trials with everything else.

Do not present any accuracy figure that the exported summary does not contain,
and do not describe a trial set as validating accuracy at a site or speed range
it did not cover. The full procedure and its safety constraints are in
`docs/SPEED_VALIDATION.md`; no physical field validation has been performed yet.

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
