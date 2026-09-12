# RoadLens implementation handoff

## Adaptive plate acquisition handoff — September 12, 2026

Implementation is complete and locally verified. The production behavior is a
single quality-aware lifecycle:

```
4 s minimum arming
  → search for a real eligible track
  → strong readiness, or 800 ms stable intermediate-candidate dwell
  → lock that identity (amber ACQUIRING)
  → collect/rank distinct real source crops while it approaches
  → create immutable event evidence at quality/trajectory trigger (red alert)
  → keep improving separate detail artifacts and plate consensus
  → stop early on confirmation or settle at the bounded deadline
```

The release uses an ideal 1920×1080/30 Showcase camera profile with a graceful
1280×720 fallback and visible actual settings. It can score at most 16 distinct
cadence-spaced looks over 4.8 s, retains/submits the top eight, admits OCR every
600 ms, keeps at most 768 KiB of raw plate-target pixels, and permits only one
plate request in flight. The normal/fallback readiness thresholds are
0.68/0.56; target and overall waits are 6.5/25 s. Same-frame variants cannot
satisfy consensus.

Reports keep three concepts separate:

- **Event evidence** is the original annotated frame and never changes.
- **Best Vehicle Capture** may improve up to four materially better times from
  real source crops.
- **Best Plate Detail** is optional and comes only from a real localized plate
  crop, with no upscaling or generated pixels.

Confirmed plate text still requires two distinct frames. One high-quality real
OCR result can appear only as a visibly unconfirmed possible plate. Report
revisions update an open camera detail view and paired viewer automatically.
End Session, pagehide, source/runtime reset, timeout and confirmation clear the
bounded raw-crop state; report-detail artifacts remain RAM-only and follow
normal report/session eviction.

All local release gates pass: 295 unit, 87 contract, 84 integration, 42
tracking, 11 model, 14 E2E, 10 privacy-browser, 95 worker/139 worker-subtest,
and 1 real CUDA browser integration test. Typecheck, lint, build and privacy
source scans pass. Two short matched replays measured -1.9% and +6.7% traffic
analysis-rate deltas, while the isolated interleaved benchmark measured -1.2%.
The sign-changing results show no sustained local regression and do not
establish physical-phone performance.

Application commit `6ff75f237933722fe0d1ae9ae17311026d96c7a6` is pushed to
public `main`. Vercel deployment `DsD7FGadsMDGbsWucydYRMP7qv4B` completed, and
Render manual deployment `dep-daitkam7bikc73a1ij3g` is Live from that commit.
The deployed relay advertises report protocol v2 over a real WSS owner
handshake. The public paired-browser cloud smoke and a separate 390×844
Showcase/report/viewer/download/cleanup acceptance each pass 1/1.

The hosted Vercel → Render → existing local RTX path measured 9.983 result Hz,
46.6 ms median RTT, 119 ms result age, 223 ms overlay age, 2.85 ms encode,
15.09 ms total worker time and 11.42 ms CUDA inference over 10 seconds, with
zero superseded/stale results and zero console errors. The worker application
did not change, reconnected to the restarted relay automatically, and requires
no restart for this release.

Physical iPhone acquisition, source resolution, real-road unreadable recovery,
false plate promotion and thermal behavior remain **NOT YET VERIFIED**. Follow
the exact procedure in `docs/DEMO_RUNBOOK.md`; do not infer those results from
desktop replay or public datasets.

Older release handoffs below remain as history. Their fixed-time Showcase and
four-frame rescue descriptions are superseded by this section.

## Plate rescue release handoff — September 12, 2026

The physical `visible vehicle → Unreadable` case traced to lost source pixels:
the report target was chosen after frame observation, while older plate
candidates retained only metadata. `PlateCapture.beginReportRescue` now copies
the exact report-time target crop before `annotatedEvidence` runs and keeps a
strictly bounded set of distinct follow-up crops. `RemoteDetector` can submit
those encoded snapshots after the live canvas has advanced or the vehicle has
left.

Production bounds are four 640-edge crops per report, two active reports,
96 KiB per crop, 768 KiB total, three-second TTL, and one busy retry per crop.
All blobs are RAM-only and are destroyed on confirmation, TTL, epoch reset,
pagehide, component teardown, or End Session. The report evidence blob is never
rewritten. The existing report revision/viewer synchronization path carries a
successful consensus automatically.

Integrity remains conservative: two genuinely distinct source frames are still
required; same-frame variants are deduplicated; single-frame candidates remain
disabled; no plate text is logged; `Plate located · text unreadable` is derived
only from a real detector box. Benchmarking rejected top-2/top-3 and alternate
detector sizes for production. The evaluation CLI now reproduces these audits;
worker runtime logic and relay wire schemas did not change.

Automated verification and deployment identifiers are recorded in the release
entry in `docs/STATUS.md`. Physical iPhone recovery remains NOT YET VERIFIED.

## Annotated evidence release handoff — September 12, 2026

Application commit `634c70e` replaces the plain Showcase evidence frame with
one bounded, baked report image. The annotation is generated once from the
exact completed canvas and the exact observed track in that frame: red target
box, `TRAFFIC ALERT`, real class/ID/score, and a conditional same-frame inset
for small targets. No later live coordinates, second inference, inferred box,
plate text or speed value can enter the render.

`SessionStore` retains only the annotated JPEG, not a second raw copy. The
existing report modal, download helper and viewer evidence request therefore
all use byte-identical marked evidence. The release sample was 71,846 bytes,
inside the existing 80 KiB target and 128 KiB wire cap. All lifecycle cleanup,
20-image/8 MiB RAM bounds and no-persistence rules remain unchanged.

The detail drawer removes `Entered demo limit` and `Demo margin`, adds
professional measurement mode/speed status wording, and hides limit/margin
when none was configured. Handheld speed remains null, plate text still
requires real consensus, and genuine mounted speed promotion remains intact.

Verification: 272 unit, 85 contract, 84 integration, 42 tracking, 11 model,
14 E2E and 10 privacy browser scenarios pass; source/privacy scans cover 53
application modules and 224 tracked files. Compiled same/split production,
95 worker tests/139 subtests and actual CUDA acceptance pass. Vercel deployment
`GYX9nLWHV8ucjZmiG2VagtJ76XsR` is successful, and the public frontend passed
the annotated camera/viewer/download acceptance 1/1 against the unchanged
Render relay. Physical-phone acceptance remains **NOT VERIFIED**.

## Showcase release handoff — September 12, 2026

RoadLens now has a top-level **Showcase** switch on the Camera page. It defaults
off and does nothing beyond one boolean check while off. When enabled, it waits
for five seconds of completed source-time analysis, deterministically selects
one real stable vehicle, locks the existing selected-track identity, draws only
that target red, creates one existing-schema RAM report with one bounded event
image, and requests the existing plate pipeline for the same track. It does not
create a second inference, tracking, OCR, reporting or viewer architecture.

The truthful boundaries are explicit: a red box means presentation target, not
a speeding violation; handheld speed remains null; plate text is absent unless
multi-frame OCR consensus actually succeeds; no eligible car means no event;
browser fallback reports plate unavailable; and a real mounted speed candidate
is deduplicated into the same report identity. `Showcase trigger` appears in the
observation detail and paired viewers receive the normal report revisions and
evidence request flow.

State is browser-RAM only. Toggle off clears its target, while End session and
pagehide clear reports/evidence/plate consensus as before. Source, orientation,
camera or inference-runtime continuity resets re-arm an enabled run and never
carry an identity across capture epochs. An enabled run creates at most one
automatic event; an explicit off→on is required for another.

Release-candidate verification is green: 267 unit, 85 contract, 84 integration,
42 tracking, 11 browser-model and 14 browser E2E tests; one compiled same-origin
and one split-origin production smoke; and one actual browser/relay/RTX 5070 Ti
CUDA acceptance including a real Showcase plate request. Two fair five-second
desktop replay samples measured 4.62 Hz off vs 4.58–4.80 Hz on (4.69 median);
640 CUDA integration measured 8.27 result Hz before vs 8.53 after. See `docs/STATUS.md` and
`docs/DEMO_RUNBOOK.md` for the evidence boundaries and exact presentation flow.
Privacy scans and 10/10 privacy browser scenarios pass; the unchanged worker
passes 95 tests/139 subtests and its real startup/Ctrl+C check.

Physical phone/cellular operation, live-road plates and field speed accuracy are
still **NOT VERIFIED**. No backend, Render relay, shared protocol or worker
runtime source changed in this release; the frontend production deployment is
the affected service.

Application commit `0b7d0a022e2fb9e70b7ab7198bf567c616824c5e` is on public
`main`. Vercel deployment `3PmeyLWHV8ucjZmiG2VagtJ76XsR` completed successfully,
and the public URL passed the Showcase paired-browser acceptance 1/1 against the
unchanged deployed Render relay. That is deployed desktop-browser evidence, not
the outstanding physical-phone acceptance.

The current application adds an optional Windows NVIDIA detector to the existing browser detector. GPU mode requires that computer to be running and connected outbound to the relay. Browser mode retains camera-side inference and does not require a desktop worker. Tracking, calibration, rules and temporary reports remain authoritative in the camera browser in both modes.

The new request supersedes the earlier local-worker prohibition. It does not authorize cloud GPU inference, an inbound worker server, tunnels, accounts, a database or persistent media storage.

## Actual release status

| Gate                      | Status and observed evidence                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core implementation       | Implemented: camera/replay, exact-frame analysis, temporary pairing/viewers, tracking, reports/review/downloads and qualified speed logic.                                            |
| Browser model             | Verified on desktop: actual YOLO26n FP32 ONNX 416/320, worker WASM execution and real-photo Python/browser parity.                                                                    |
| Local NVIDIA inference    | Verified: YOLO26n/s/m at 640 through PyTorch CUDA and ONNX CUDA, including actual model execution and parity.                                                                         |
| GPU browser integration   | Passed 1/1: actual 640/960 detections, paired viewer/review, worker-loss WASM fallback, worker restart/explicit GPU return, relay restart/report preservation/Resume and End cleanup. |
| Current automated suites  | 124 unit, 49 contract, 61 real relay, 11 browser-model and ten E2E/privacy scenarios passed. Build/lint/typecheck, compiled same-origin and split HTTPS/WSS smokes passed.            |
| Calibrated speed logic    | Deterministic geometry, source-time tracking, invalid-state gates and candidate persistence tested.                                                                                   |
| Real-field speed accuracy | Unmeasured: no independent ground-truth trial or error statistics.                                                                                                                    |
| Cloud deployment          | Updated Vercel frontend is Ready/Production on Hobby. No deployed relay or production worker connection.                                                                              |
| Cloud smoke               | Current frontend-only smoke passed 1/1 in 9.0 seconds; full paired cloud/GPU smoke and provider restart not run.                                                                      |
| Physical phone            | Not verified: rear camera, cellular/second-network and sustained thermal behavior remain untested.                                                                                    |
| Free-plan constraints     | Relay creation blocked: authorized Render account permits billable overages, contrary to the prior strict no-overage condition.                                                       |
| Optional features         | OCR and wrong-way disabled; custom training not run; TensorRT unverified and unselected.                                                                                              |

## Deployment and source

Public frontend: https://roadlens-ai-five.vercel.app. Public application repository: https://github.com/kokoc30/roadlens-ai. GPU application source was committed and pushed to main at `cda1d9692e1c2fdb6b3cbf3095e51591103afa5d`. Subsequent documentation-only commits seal observed release evidence; no history was rewritten. Original private instruction packs, user configuration and generated GPU caches remain excluded and preserved locally.

Vercel deployment `54cGHoj5eVufwtUxHjt2nBRHpJxk` was verified Ready/Production against that source SHA, with a 20-second build, the existing production domain and 19 static assets; no functions, analytics or paid services were added. GitHub's Vercel status also reported success. Gitleaks 8.30.1 found no leaks in 149 public text files and the three-commit history scan.

The Vercel Hobby build remains frontend-only with VITE_SHARING_DISABLED=true. Camera/replay and local reports work there; Share/Connect and GPU mode are not deployed. The current public smoke passed 1/1 in 9.0 seconds: actual 416/320 inference, local reports/downloads, cleanup, HTTPS model/runtime hashes and MIME, missing-asset 404s, no unexpected API requests and zero page/console errors. Local development services were stopped. This verifies the updated public browser fallback, not a public GPU path.

Vercel static and Render Free relay configurations and the single-Render fallback are prepared. No relay URL has been invented, no cloud Python/GPU service was created, and billing settings were not changed. Deployment needs an authorized workspace satisfying the existing no-overage constraint.

## What is implemented

The default local worker is balanced: YOLO26s, 640, PyTorch CUDA FP32. Fast/balanced/quality map to tested n/s/m checkpoints. ONNX CUDA also passed. TensorRT produced no engine within its bounded five-minute attempt; normal start does not rebuild engines. Python CPU inference is not a silent fallback.

start.ps1 locates the project independently of the current directory, reads its configured environment, checks actual CUDA and cached artifacts, warms the detector, then authenticates to /worker. Normal start installs nothing. One dedicated native thread handles construction, warmup, inference and cleanup. There is one active inference and no application waiting queue. Cancellation retires the current identity; disconnect fences old results and delays new readiness until native work finishes. Heartbeats and bounded exponential reconnect are implemented.

The camera acquires /gpu only after its original room owner handshake. Binary RLG1 JPEG requests and results must match room, source, epoch, sequence, source time and dimensions before the associated captured canvas renders. Viewers never load a detector or request their own camera. Runtime/source changes reset measurement continuity. Worker loss can use actual browser WASM; returning to GPU is an explicit transition.

A combined frontend/relay outage also removes access to uncached browser model assets. The real GPU E2E verified visible fallback-load failure and pause while preserving three camera-local reports, then successful explicit Resume after service restoration. Old pairing expired with socket close code 1008 and the viewer cleared. Automatic fallback during an asset outage is not claimed.

The existing camera-side time_aware_iou_v1 tracker, background guard, geometry, speed estimator, rules and report serializer remain authoritative. The tracker is ByteTrack-inspired, not an official port. Counts use currently observed objects. Directed crossing logic is module-tested; no crossing-line drawing UI is claimed. Browser mode retains measured 416→320 adaptation.

## Models and measurements

Browser inference uses fixed FP32 YOLO26n ONNX with images [1,3,S,S] and inspected output0 [1,300,6] xyxy/score/class semantics. RGB letterboxing, inverse coordinates and semantic COCO mapping expose person, bicycle, car, motorcycle, bus and truck. Unknown output semantics fail visibly. Matching ONNX Runtime Web 1.29.0 assets run single-thread WASM; WebGPU is not enabled.

| Browser profile |     Bytes | SHA-256                                                          |
| --------------- | --------: | ---------------------------------------------------------------- |
| 416             | 9,796,924 | 703143276b5c7c32c18299510f490b3079e256fbd7866d891a1ef030a640ea21 |
| 320             | 9,767,944 | 3462385c62a59f028a400b71ecfa200c53880854f2e5078b73edb3c536d1ba02 |

Browser export used Ultralytics 8.4.146, Torch 2.14.0+cpu, ONNX 1.20.1 and Python 3.13.12. The separate GPU environment uses Python 3.13.12, Torch 2.14.0+cu130, torchvision 0.29.0+cu130, cuDNN 9.24, ONNX Runtime GPU 1.29.0 and websockets 17.0.1 on an RTX 5070 Ti, driver 610.74, system CUDA toolkit 13.0.48. No global Python, driver or CUDA configuration was changed. worker/model-catalog.json and local artifact manifests record provenance, licenses and hashes.

The clean 20-run benchmark measured balanced PyTorch CUDA at median 7.40 ms inference / 13.88 ms total worker processing after warmup. All six n/s/m and PyTorch/ONNX combinations passed. A real ONNX profile placed 290 nodes on CUDA and zero on CPU. Photo parity passed IoU >0.99 and score difference <0.005. These repeated-photo timings exclude network, tracking and browser rendering; they are not phone FPS, traffic mAP or difficult-scene accuracy. Torch-managed allocation is not total process/ORT VRAM. See GPU_BENCHMARK.md and MODEL_VALIDATION.md.

## Tests and measurements

| Layer                              | Executed evidence                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean preparation                  | npm ci passed: 273 installed / 277 audited, zero audit findings. Model preparation, production build, lint and typecheck passed.                                                                                                                                                                                                                                       |
| Current core                       | 124 unit + 49 contract + 61 real relay = 234 tests passed; build/lint/typecheck passed.                                                                                                                                                                                                                                                                                |
| Current browser model              | 11/11 actual browser-model tests passed in 6.3 seconds.                                                                                                                                                                                                                                                                                                                |
| Current general E2E                | 10/10 passed in 1.6 minutes.                                                                                                                                                                                                                                                                                                                                           |
| Current privacy                    | Persistence scan passed across 35 modules; 10/10 browser privacy scenarios passed in 1.6 minutes.                                                                                                                                                                                                                                                                      |
| Current compiled same-origin smoke | Real paired browser flow passed 1/1 in 17.1 seconds.                                                                                                                                                                                                                                                                                                                   |
| Current split-origin smoke         | Real paired HTTPS/WSS production smoke passed 1/1 in 20.3 seconds.                                                                                                                                                                                                                                                                                                     |
| Pre-GPU baseline                   | 106 unit, 34 contract, 33 real relay, 11 browser-model and nine E2E/privacy scenarios passed before edits. Prior compiled same-origin and split HTTPS/WSS paired smokes each passed 1/1.                                                                                                                                                                               |
| Worker suites                      | npm run test:worker passed 39 tests and 68 subtests in 6.06 seconds, including real CUDA parity and explicitly synthetic transport/lifecycle/preparation fixtures. The earlier cached setup run passed in 5.77 seconds.                                                                                                                                                |
| Normal startup                     | Actual start.ps1 from a nonproject directory reached CUDA readiness and relay registration. Two bad configurations failed without secret output. Genuine Windows Ctrl+C stopped the worker and all owned descendants and cleared the relay socket. Repeated isolated ConfigPath runs preserved existing user configuration; the final npm run test:start rerun passed. |
| Cached setup                       | Exited 0 from a nonproject directory; verified cached models, worker tests and six five-run GPU benchmarks. Original six-profile 20-run evidence was preserved separately.                                                                                                                                                                                             |
| Current full GPU E2E               | Passed 1/1 in 22.5 seconds total, 18.6 seconds test time. Actual browser/relay/CUDA, 640/960 sampling, viewer review, worker loss→WASM, worker restart→explicit GPU, combined-server restart→preserved reports/visible pause/Resume, old-pairing expiry and End RAM cleanup all passed. Browser console errors: zero.                                                  |
| Training safeguards                | 21 synthetic tests passed in 0.133 seconds. No actual training ran.                                                                                                                                                                                                                                                                                                    |
| Secret scan                        | Gitleaks 8.30.1: no leaks in 149 public text files.                                                                                                                                                                                                                                                                                                                    |
| Publication                        | Application source pushed; updated Vercel frontend and current public smoke passed. Cloud relay/GPU, physical-phone and field gates remain separate.                                                                                                                                                                                                                   |

After local verification, ports 5173, 10000, 10002 and 10006 were not listening. This confirms cleanup of the checked local test services, not deployment of a cloud relay.

The successful GPU browser artifact is docs/evidence/gpu-browser-pipeline.json, recorded at 2026-09-11T03:23:02Z. Masked screenshots at 390-pixel mobile width and 1440-pixel desktop width were inspected.

| Local replay measurement                                | 640-pixel analysis | 960-pixel analysis |
| ------------------------------------------------------- | -----------------: | -----------------: |
| Completed measured frames                               |                 36 |                 26 |
| Mean WebSocket result round trip, excluding JPEG encode |           17.84 ms |           20.29 ms |
| Mean GPU inference                                      |            8.97 ms |            9.86 ms |
| Mean total worker processing                            |           13.94 ms |           17.75 ms |
| Camera snapshot result rate                             |           9.397 Hz |           7.930 Hz |
| Camera snapshot source rate                             |           14.94 Hz |           14.83 Hz |
| Camera snapshot processing time                         |            27.2 ms |            42.7 ms |
| Camera snapshot frame age                               |            21.5 ms |            36.5 ms |

These short loopback replay measurements are distinct from the worker-only benchmark. Round trip uses one browser clock and excludes encoding; it is not one-way network latency. Snapshot rates/ages are sampled camera diagnostics, not sustained phone or public-network performance.

Prior measurement evidence includes 51 deterministic tracking/geometry/rule tests and 32 report/session tests. Numerical motion and texture fixtures are synthetic. The permitted replay fixture runs actual inference, not prerecorded detection JSON. Simulated Chromium cameras and mobile viewports are not physical phones. See GPU_RELEASE_RESULTS.md and ACCEPTANCE_RESULTS.md for final layer-specific totals.

## Temporary data and access

Eight-character Crockford invitations expire after ten minutes; rooms after sixty minutes. One owner and at most two viewers use independent automatic RAM capabilities and role-bound exact-origin sockets. There are no application accounts, public room directory, database or durable report history. The owner can rotate, revoke and end sharing; reconnect/late joins resynchronize from the still-open camera.

Worker authentication is separate. Its shared secret stays in ignored worker configuration/process environment and relay environment, never frontend variables, URLs or content logs. The relay can see transported content; WSS is not end-to-end encryption.

Reports are capped at 200; optional evidence starts off and is bounded by 20 images/8 MiB. Tracking holds at most 100 identities/32 observations each. Null-speed observations, source-authoritative reviews and explicit JSON/CSV/image downloads are supported. No app localStorage, sessionStorage, IndexedDB, Cache Storage, disk media repository or relay evidence history exists. Public app/model caching, local model/engine caches, explicit test/benchmark artifacts and user downloads are separate permitted outputs.

Viewer previews remain default 1 Hz/max 2, JPEG long edge 640, target 80 KiB/hard 128 KiB. No viewers means no viewer-preview upload. Enabled GPU analysis still sends its bounded JPEG requests: default edge 640, optional 960, hard 192 KiB and one in flight. Both paths count fanout against the 128 MiB room/256 MiB process-boot application limits, which do not guarantee provider billing limits.

Pause stops media and invalidates measurement continuity. Stop sharing can preserve local reports while releasing GPU access and using browser analysis. End/pagehide/BFCache cleanup releases media, workers, sockets, evidence and relevant settings. Reload loses RAM; relay restart invalidates pairing even when local reports remain. Downloads/screenshots cannot be revoked.

## Speed and disabled scope

Numeric speed requires a fixed, approximately planar, measured setup, independent calibration check, stationary background, stable observed identity and adequate source-time samples: at least eight qualified observations over 1.5 seconds, at least 4 Hz, no gap over 350 ms, at least 3 m displacement, plus residual/direction gates. Unverified samples cannot later enter qualified speed history. Unavailable speed remains null/“—”. Detector confidence is not speed accuracy or violation probability. Entered limits/margins are demo settings; persistence, hysteresis and episode dedup produce review candidates, not legal citations.

Real-field accuracy is unmeasured: no ground-truth sample, MAE, median error or maximum error exists. MEASUREMENT_RELEASE_AUDIT.md provides a safe controlled evaluation protocol recording attempted passes and unavailable coverage without encouraging unsafe driving.

Wrong-way remains disabled. Plate recognition is implemented and measured on licensed public data (see docs/PLATE_RESULTS.md); it has no physical camera validation yet, so it ships as EXPERIMENTAL. No consented readable-plate evaluation, successful integrated OCR test or complete controlled wrong-way workflow exists. Custom training has not run; 21 freshly rerun synthetic training safeguards do not establish training or accuracy. The pretrained application needs no training dataset.

## Commands and remaining actions

With the pinned Node toolchain, the implemented commands are:

```powershell
npm ci
npm run model:prepare
npm run build
npm run lint
npm run test:unit
npm run test:contracts
npm run test:integration
npm run test:model
npm run test:e2e
npm run test:privacy
npm run test:production
npm run test:split-production
npm run deploy:verify
```

For optional Windows GPU operation, use Python 3.13 and the verified NVIDIA environment. Setup installs only into worker/.venv. Configure the ignored .env.worker with the actual WSS /worker endpoint and privately matching relay secret before normal start:

```powershell
.\setup-worker.ps1
.\start.ps1
# Run GPU checks separately, without concurrent GPU benchmarking:
npm run test:worker
npm run test:start
npm run test:gpu
npm run gpu:benchmark
```

The startup check uses an isolated nonexistent configuration path and a temporary loopback relay; it does not read or modify user configuration. test:gpu is local integration, not production verification. GPU_WORKER.md contains exact configuration and troubleshooting.

Complete deployment only with an authorized Render workspace meeting the existing no-overage constraint. Deploy the prepared free relay, configure exact frontend origins and private worker secret, rebuild the frontend with the actual HTTPS relay endpoint and sharing enabled, then verify pairing, GPU, fallback, reports, cleanup and restart. npm run smoke:cloud requires actual ROADLENS_BASE_URL and HTTPS ROADLENS_RELAY_URL origins in its test process; the separate worker configuration uses WSS /worker.

Finally test a physical phone on cellular with the viewer on another network. GPU mode intentionally needs the local worker; browser fallback can operate with it stopped. Field-speed evaluation is a separate controlled task.

## Demo

The deployed camera-only demo supports Start camera or labeled Replay, actual browser detection, local observations and explicit downloads. A local paired demo uses npm run dev and two browsers; optional worker instructions are in GPU_WORKER.md. After cloud deployment is authorized and verified: start camera → enter code on viewer → view exact analyzed frames → save a real observation → review/export below video → End clears the session. Use speed only with a mounted measured setup; otherwise demonstrate null speed honestly.
