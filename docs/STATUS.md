# RoadLens release status

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
Plate OCR and wrong-way remain disabled; no training ran.


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
