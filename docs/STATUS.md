# RoadLens release status

## Report-target plate rescue — September 12, 2026

Implemented a bounded original-pixel rescue path for Showcase and new speed
reports. The exact report frame is cropped before evidence annotation, then up
to four distinct looks of that same track are retained for three seconds in
RAM. A vehicle may leave after the collection window and the already-retained
crops can still finish the existing worker/consensus pipeline. Busy crops retry
once; traffic inference remains authoritative and the worker still admits no
plate work ahead of traffic.

Consensus now deduplicates by source-frame identity. Same-image transforms or
retries cannot satisfy the two-frame floor. Single-frame plate candidates are
disabled. Reports still move automatically from `Analyzing…` to a confirmed
plate or an honest final state, and the existing `report.upsert` revision path
keeps the paired viewer aligned. `Plate located · text unreadable` distinguishes
successful localization from no localization without adding a wire field.

The rescue cache is separate from evidence: 2 reports × 4 crops × 96 KiB =
768 KiB maximum, 3 s TTL, and immediate cleanup on confirmation/reset/end. The
annotated evidence bytes and download remain immutable. No persistent storage,
plate logging, database, or generative enhancement was introduced.

Measured remedy audit: 640 top-1/top-2/top-3 were identical at 86.49% exact;
768 detector input reduced exact match to 86.04%; 960 detector input reduced
recall. A 960-edge transport simulation improved compressed-crop exact match
over 640 (85.14% vs 77.03%), but was not shipped because it exceeds the current
strict 640 wire contract and lacks independent physical RoadLens validation.
Worker production logic and the relay protocol are unchanged.

Automated release gate: typecheck, lint and production build pass; 281 unit,
85 contract, 84 integration, 42 tracking, 11 browser-model, 14 E2E, 10
privacy, 95 worker tests / 139 worker subtests, and the real CUDA GPU pipeline
pass. Two E2E performance comparisons measured Showcase/rescue deltas of +1.6%
and -2.8% on the same local replay path, straddling zero within normal run
variation. Physical iPhone recovery remains NOT YET VERIFIED.

## Annotated report evidence — September 12, 2026

Showcase reports now retain one **baked annotated JPEG** rather than an
unmarked scene. The renderer consumes the exact completed analysis canvas and
finds the exact observed report track in that same immutable `FrameResult`.
It draws only that target with the existing red `TRAFFIC ALERT` language plus
real class, stable track ID and detector score. The full frame remains visible;
a same-frame target inset is added only when the reported vehicle is small.
Nothing is re-detected or read from the later live view.

The annotated JPEG is the single bounded image retained in `SessionStore`.
The camera modal, explicit download and paired viewer therefore consume the
same bytes through the existing evidence request path. The raw image is not
retained as a second copy, avoiding doubled RAM. The verified replay artifact
was 71,846 bytes, below the existing 80 KiB target and 128 KiB protocol cap.
End session/pagehide eviction and all prior RAM-only limits are unchanged.

Report details now say `Measurement mode`, `Speed status`, `Configured speed
limit` and `Candidate margin`. The old `Entered demo limit` / `Demo margin`
labels are gone, and limit/margin rows are hidden when no speed limit was
configured. Handheld Showcase reports continue to say `Mounted calibration
required`; no speed or plate fallback was added.

Fresh verification on application commit `634c70e` follows: 272/272 unit,
85/85 contract, 84/84 real relay integration, 42/42 tracking, 11/11
browser-model, 14/14 browser E2E and
10/10 privacy browser scenarios pass. Privacy scans cover 53 application
modules and 224 tracked files. Worker tests remain green at 95 tests/139
subtests, and the actual browser → relay → RTX CUDA acceptance passes 1/1.
Typecheck, lint, build, compiled same-origin and split-origin production smoke,
and all three deployment-schema checks pass.

The local matched Showcase diagnostic measured 4.871 analyzed Hz off and
4.936 Hz on. The deployed run measured 4.239 Hz off and 4.256 Hz on. Evidence
encoding runs once at report creation (and once only if that report is upgraded
to a genuine speed candidate), never per analysis frame. Camera route gzip grew
from 44.45 to 46.07 KiB. No meaningful primary detector regression was
observed; these short desktop replay samples are not physical-phone evidence.

Application commit `634c70e` is pushed to `origin/main`. Vercel deployment
`GYX9nLWHV8ucjZmiG2VagtJ76XsR` completed successfully, and the public
<https://roadlens-ai-five.vercel.app> passed the new annotated-evidence
Showcase camera/viewer/download acceptance 1/1 against the unchanged Render
relay. No backend, shared wire schema or worker application source changed.

Physical-phone layout/performance, live-road plate legibility and field speed
accuracy remain **NOT VERIFIED**.

## Showcase release — September 12, 2026

The release candidate adds one compact, accessible **Showcase** switch to the
Camera page. It is disabled by default and is a thin RAM-only controller over
completed real analysis frames. The detector and tracker remain unchanged:
browser fallback still runs YOLO26n/ONNX Runtime Web, the optional worker still
runs YOLO26s/PyTorch CUDA, and `time_aware_iou_v2` remains authoritative in the
camera browser. No backend, relay schema, shared wire schema, worker runtime,
account, database, analytics or durable storage was added.

After five seconds of advancing analyzed source time, the controller considers
only observed, tracker-confirmed, non-ambiguous vehicle tracks with confidence at
least 0.60, at least 100 ms observed duration and a crop long edge of at least
64 source pixels. A deterministic score combines image area, centrality, edge
clearance, observed duration, detector confidence and crop size, with lower
track ID as the final tie-break. Person/bicycle/tentative/lost/ambiguous/small
tracks are ineligible and plate text is never consulted.

One selected identity is locked, shown in red as `TRAFFIC ALERT`, passed through
the existing Selected Vehicle path, saved immediately as one temporary report,
and submitted to the existing bounded plate pipeline. A handheld Showcase event
is an observation with null speed and a visible `Showcase trigger`; a genuine
mounted speed candidate keeps the real speed semantics and reuses/upgrades the
same report ID instead of creating a duplicate. Showcase automatically retains
one bounded evidence JPEG in browser RAM even when normal manual evidence is
off. End session/pagehide clears it with the session; no browser storage write
is introduced.

Fresh release-candidate evidence:

- clean baseline started at `3170eab`; dependency install reported zero audit
  findings and the pre-edit full matrix was green;
- 267 unit, 85 contract, 84 real relay integration, 42 tracking and 11 real
  browser-model tests pass;
- 14/14 desktop browser E2E scenarios pass, including one real permitted-replay
  Showcase flow at 375/390-pixel portrait and 844×390 landscape, keyboard/ARIA,
  red target, exact report facts/evidence, paired viewer delivery, one-event
  behavior and End/pagehide/reload cleanup;
- actual local browser → relay → RTX 5070 Ti CUDA acceptance passes 1/1 with
  Showcase selecting a real GPU detection and emitting a real RLP1 plate
  request before the existing fallback/reconnect/restart checks;
- privacy scans pass across 52 application modules and 224 tracked files, with
  10/10 privacy browser scenarios; worker tests pass 95 tests/139 subtests and
  the real launcher warmup/authentication/Ctrl+C test passes;
- compiled same-origin and split-origin production smokes pass 1/1 each; build,
  typecheck, lint and all three deployment-schema checks pass.

Two matched five-second local replay diagnostics measured 4.62 analyzed
frames/s with Showcase off and 4.58–4.80 frames/s with it on (4.69 median);
matched overlay-age samples were 74/190 ms off and 59/188 ms on. This is short
headless desktop replay evidence, not a physical-phone claim. The clean pre-edit
640 CUDA path measured 8.27 result Hz,
8.08 ms mean GPU inference and 13.67 ms mean worker time; the Showcase GPU
acceptance measured 8.53 result Hz, 8.41 ms mean inference and 13.11 ms mean
worker time. The primary detector was not changed and no significant regression
is observed; these repeated-photo/loopback results are not traffic accuracy or
public-network performance.

The post-change six-profile worker benchmark also remained within the existing
runtime range: PyTorch CUDA fast/balanced/quality measured 8.09/8.26/10.05 ms
median inference and 14.75/14.86/16.95 ms total; ONNX CUDA measured
5.96/9.29/17.07 ms inference and 12.97/15.96/23.89 ms total. All profiles found
the same five real detections on the permitted fixture.

Application commit `0b7d0a022e2fb9e70b7ab7198bf567c616824c5e` is pushed to
`origin/main`. GitHub reports Vercel deployment `3PmeyLWHV8ucjZmiG2VagtJ76XsR`
successful at 2026-09-12T19:14:23Z, and the public
<https://roadlens-ai-five.vercel.app> then passed the real Showcase camera/viewer
acceptance 1/1 against the deployed Render relay. That production run covered
the five-second source-time gate, one actual browser detection/track, report and
evidence synchronization, honest unavailable plate state, red overlay,
performance telemetry, End/pagehide/reload cleanup and no page errors. Render
and worker application code are unchanged and need no deployment for this
release.

Physical phone, live-road plate legibility and field speed accuracy remain
**NOT VERIFIED**.

## Vehicle intelligence and tracking pass — September 11, 2026

Baseline reproduced on clean main `948e13a` before any edit: typecheck, lint,
223 unit and 85 contract tests green.

**The reported ID fragmentation was a tracker defect, not a detector one.**
Instrumenting `time_aware_iou_v1` showed that 21 of the 29 avoidable new
identities across the evaluation set came from its hard class gate severing a
track whenever the detector flipped an SUV between `car` and `truck`. A
single-variable sweep confirms it: dropout, box jitter, analysis cadence and
object size each caused zero identity switches on a clean traversal, while class
instability caused all of them.

`time_aware_iou_v2` ships. Over 23 scenarios it takes identity switches from 50
to 0 on the correctness tier and 73 to 3 on the adversarial tier, with distinct
IDs per vehicle falling 2.01 to 1.00 and 2.29 to 1.11, false merges 5 to 3, IDF1
0.897 to 0.938 and MOTA 0.821 to 0.899. It matches a reference ByteTrack on
identity switches and beats a reference BoT-SORT on every metric. Evidence,
tuning sweeps and two rejected approaches are in `docs/TRACKING_EVALUATION.md`.

Added product layer: tap-to-select with a Selected Vehicle card (class, stable
ID, detection confidence, tracking state, observed duration, frame-relative
motion, speed or the reason there is none, plate), operator-triggered plate
reading for the selected vehicle with a plate-localisation marker, an explicit
handheld/mounted mode badge, and identity copy unified as `CAR · ID 12` across
overlay, card and reports.

**Handheld absolute speed is DISABLED and not prototyped.** A moving monocular
camera mixes its own motion into the measurement and would produce plausible,
smoothly-varying, wrong mph that passes every existing validity gate. Handheld
mode reports direction, never a rate. Research and the conditions that would
change this: `docs/HANDHELD_SPEED_RESEARCH.md`.

**The detector is unchanged: YOLO26s at 640.** Measured on the RTX 5070 Ti, the
three available models span 1.6 ms of inference and 1.4 ms of worker total, which
is not observable against a network-dominated end-to-end budget. Relative recall
between them is **unmeasured** and no recall table is published, because the only
licensed fixture is a single photograph. `docs/DETECTOR_AUDIT.md`.

Suites on the shipped build: 243 unit, 85 contract, 42 tracking, 13 E2E
(including 10 privacy), 95 worker tests with 139 subtests. Physical validation
is **NOT VERIFIED** and the procedure is `docs/PHYSICAL_VALIDATION.md`.

### Production verification, September 11, 2026

Verified against the deployed Vercel frontend, the deployed Render relay and the
local RTX 5070 Ti worker connected outbound:

- worker registered and advertising the plate pipeline: relay reports
  `gpu: {enabled: true, state: "ready"}`, model `yolo26s-640-pytorch_cuda-v1`,
  OCR `fast-plate-ocr`, plate read latency 202 ms median;
- paired camera/viewer cloud smoke passes end to end, including reports, the
  state snapshot and cleanup;
- tap-to-select on the live build: `BUS · ID 1`, detection 95%, tracking state
  confirmed, motion reported, speed withheld as `Mount and calibrate for speed`;
- **one identity held for 36.6 s of continuous observation with no ID change**,
  which is the claim this release exists to make.

Two defects were found this way and fixed, neither of which the offline suites
had caught:

1. The frame-protocol negotiation stripped the new frame-level fields but not
   the new per-track ones. `TrackSchema` is strict too, so a relay deployed
   before this release refused any frame carrying a track — and refusing a
   header disconnects the camera rather than dropping a frame. The viewer sat on
   "Source offline" while the camera analysed normally.
2. Plate analysis could stall on "Analyzing…" permanently. Candidates were
   ranked by quality and truncated, while only a current-frame candidate can be
   cropped from the canvas in hand; on a steady scene the current look was
   evicted every time. A deadline now backs up the fix so no request can hang.

**Render still needs a manual deploy** (`autoDeployTrigger: off`) for the
`frameProtocol` advertisement in `backend/src/relay.ts`. Until then the camera
negotiates down and viewers simply do not receive mode, selection or motion;
nothing else is affected and nothing measured changes.


After the fix, the same live path settles correctly: `Analyzing…` for about
twelve seconds, then `Unreadable`, with two reads completed at 174 ms median —
the right answer for a photograph carrying no legible plate. A plate that two
frames agree on still reports as read regardless of the deadline, so the
deadline can only convert an absent answer, never a real one.

## Final intelligence pass — September 11, 2026

Baseline reproduced on clean main `b75faec` before any edit: typecheck, lint,
169 unit, 49 contract, 61 relay tests, plus the pipeline benchmark re-measured
against the real RTX 5070 Ti, which reproduced the recorded figures.

The analysis pipeline now carries two bounded frames instead of one, enforced
identically at camera, relay and worker with no queue anywhere. Matched A/B on
real CUDA: analysis rate doubles where round trip dominates (5.01 → 10.00 Hz at
125 ms RTT; 3.34 → 6.67 Hz at 207 ms), overlay age falls about 29%, result age
unchanged, zero superseded and zero stale results. This also lifts high-latency
paths above the estimator's 4 Hz sampling gate, which one frame in flight could
not clear at 207 ms RTT. Ordering is gated at the relay (strictly newer
identities per epoch, exact frameId correlation) and at the camera (superseded
and over-age completions discarded before tracking, speed, rules or display).
Full policy in `docs/LATENCY_POLICY.md`; measurements in
`docs/PIPELINE_BENCHMARK.md`; decisions and non-decisions in
`docs/INTELLIGENCE_PASS_DECISIONS.md`.

Added: speed-validation trial recording with MAE, median, p95 (suppressed below
20 trials), maximum and signed bias, JSON/CSV export, and calibration Valid/Weak
grading with named reasons. Field speed accuracy remains NOT MEASURED; the
operator procedure is `docs/SPEED_VALIDATION.md` and its results table is empty.

Final suites on the shipped build: 189 unit, 49 contract, 62 relay integration,
11 real browser-model, 12 E2E, 10 privacy with a module scan, 1 compiled
production, 1 split-origin production, 3 deployment schemas, 40 worker tests
with 68 subtests, and 1 real-GPU browser acceptance. Gitleaks 8.30.1 found no
secrets in the 170 committable files. The launcher test now falls back to
Windows PowerShell and reports its CTRL_C_EVENT phase as not exercised there.

**Cloud pairing is now verified.** The real paired browser flow passes against
the deployed Vercel frontend and the deployed Render relay together. With the
local worker connected outbound to the production relay, the hosted path
measured 49–58 ms RTT, 9.5–10.0 analysis Hz, 123 ms result age, 230 ms overlay
age, 8.9 ms GPU inference, depth 2 held, zero superseded and zero stale. The
graceful-degradation path was also observed in production: while the frontend
was deployed ahead of the relay, the client detected the refusals and settled at
depth 1 rather than thrashing.

Still unverified: physical iPhone behaviour after these changes, field speed
accuracy, and detection quality metrics (no licensed traffic evaluation set).
Wrong-way remains disabled. Plate recognition is implemented on the optional GPU worker and validated on licensed public data; a single-class plate detector was trained locally from the pinned official YOLO26n checkpoint. Physical plate validation with a real camera has not been performed. See docs/PLATE_RESULTS.md.


## GPU upgrade — active September 11, 2026

The latest explicit user request supersedes the old browser-only/local-worker prohibition: add an optional outbound local Windows NVIDIA detector, preserve WASM fallback and all RAM-only pairing/report semantics. Initial Git main was clean at5917cb24d8c6540ce8f4649dafd8b46a55968e64. No preexisting changes were overwritten.

P0 baseline reproduced before source edits: npm ci (0 vulnerabilities), model:prepare, typecheck, lint,106 unit,34 contract,33 real relay,11 real browser-model,9 E2E,9 privacy E2E plus32-module scan, build, compiled paired production1/1 and all3 deployment schemas PASS. Production smoke18.0s. Hardware observed: RTX5070Ti16303MiB, driver610.74, compute12.0, nvcc13.0.48, Python3.13.12. CUDA neural inference is not yet established by this preflight.

P1–P7 implemented and verified locally: separate versioned GPU transport, isolated CUDA runtime, synchronized camera integration, fallback, launcher and benchmark. Final core suites pass 124 unit, 49 contract and 61 relay tests; worker tests pass 39 tests and 68 subtests. Real GPU browser acceptance passes 1/1 in 22.5 seconds; full browser E2E and privacy each pass 10/10 in 1.6 minutes, with a 35-module privacy scan. Browser-model tests pass 11/11 in 6.3 seconds. Compiled same-origin and split HTTPS/WSS paired production tests each pass 1/1 in 17.1 and 20.3 seconds. Normal Windows startup/Ctrl+C passes; 21 synthetic training safeguards pass without training. Clean install has zero reported vulnerabilities; model preparation, typecheck, lint, build and all three deployment schemas pass. Camera remains authority for time_aware_iou_v1, source-time geometry/rules and report revisions. Local test ports are stopped. Public application files passed Gitleaks 8.30.1 with no leaks. GPU application source was pushed at cda1d9692e1c2fdb6b3cbf3095e51591103afa5d. Vercel verified Ready/Production, 20-second build and 19 static assets; the updated frontend-only public smoke passed 1/1 in 9.0 seconds with actual dual-profile browser inference, reports, cleanup and zero console errors. Documentation-only release sealing follows. P8 remains blocked by the existing no-overage Render account constraint. P9 physical phone and field accuracy remain unverified. OCR/wrong-way remain disabled and training unrun.

## Historical browser-only release evidence

Release-hardening run, September10–11,2026. This repository contains the actual application, locked dependencies, real model assets, tests and free-hosting configurations. Physical-phone and field-speed verification remain separate external gates.

## Initial state and preservation

The original implementation run began with specification files only and no Git repository. The release-hardening run began with a substantial working application but no Git metadata. It first reran the complete clean baseline: npm ci/model preparation/typecheck/lint,88 unit,34 contract,25 relay integration,11 real browser-model,6 E2E,6 privacy E2E, production build, compiled paired smoke and deployment schema checks all passed. No supplied checklist was treated as proof.

Git is now initialized on main. The latest request authorizes application-only AGPL source publication. Original requirements, specialist packs and research remain preserved locally, excluded from the release. Earlier generated handoff/status files are archived privately for continuity. No global configuration, billing changes, force-push, reset or unrelated project modification occurred.

## Release fixes

- Prevented background-unverified observations from entering later speed history; kept all sampling/coverage/residual gates unchanged.
- Reclaimed lost-track capacity for currently observed new objects while preserving bounded arrays and monotonic IDs.
- Validated frozen report facts/policy and explicit object selection; empty observations keep null speed with a reason.
- Added bounded model load/inference watchdogs, exact decoder/preprocessing manifest checks and malformed-dimension rejection.
- Added measured416→320 adaptation, bounded analysis scheduling, source-stall clearing, replay→device-camera control, and mph/km/h display/settings.
- Tightened canceled request handling and owner reconnect snapshots, serializing competing viewer state requests.
- Hardened optional training dataset/resume/promotion validation.21 synthetic safeguard tests pass; no training ran.
- Added a frontend-only deployment mode that visibly disables sharing when no authorized relay exists.

## Current release gates

Final cold-start privacy/E2E passes9/9; production build,11 model tests,1 compiled same-origin and1 split-origin HTTPS/WSS real paired browser flow pass. Exact command results are in RELEASE_RESULTS.md. Application commit c1f32553509918fae55a9eea86a78f06f8ab9099 is public at https://github.com/kokoc30/roadlens-ai. Vercel frontend-only production https://roadlens-ai-five.vercel.app is Ready and passed real dual-profile browser/local-report smoke. Model hashes are unchanged; the final11 real-model browser tests passed in6.7seconds. The pre-staging Gitleaks8.30.1 scan found no secrets in149 project text files, including preserved instructions; generated dependencies/environments were inventoried and excluded from publication.

Render creation remains blocked: the authorized account explicitly permits billable overages, which violates the user's strict no-overage condition. Do not create a service until a suitable authorized workspace is verified. Vercel frontend-only release is deployed at https://roadlens-ai-five.vercel.app, with sharing explicitly disabled. The public smoke passed1/1 in9.2seconds; no local service was running. Full cloud pairing remains NOT RUN.

Physical rear-camera behavior, sustained phone performance, cellular/second-network pairing, deployed relay restart and field ground-truth accuracy remain unverified. OCR and wrong-way are disabled; custom training/promotion did not run.
