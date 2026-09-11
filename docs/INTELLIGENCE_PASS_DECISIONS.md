# Final intelligence pass — decisions and evidence

September 11, 2026. Each decision below records what was measured, what was
changed, and what was deliberately not done. Priorities follow the request's
P0–P7 order.

## P0 — Preserve working production behaviour

Baseline reproduced before any edit: typecheck, lint, 169 unit, 49 contract and
61 relay integration tests green on the unmodified tree at `b75faec`. The
pipeline benchmark was re-measured against the real RTX 5070 Ti worker and
reproduced the recorded figures (10.01 / 8.0 / 5.00 / 3.37 analysis Hz at 0 / 60
/ 120 / 200 ms added latency), confirming the documented baseline was real.

Architecture preserved unchanged: native `<video>` with a transparent overlay,
outbound authenticated worker, browser WASM fallback, RAM-only session state,
code-based pairing, no database, no accounts, no cloud GPU.

## P1 — Analysis latency — DONE, measured, adopted

**Change.** Pipeline depth raised from one outstanding frame to
`GPU_LIMITS.maxInFlight = 2`, enforced identically at all three stages, with no
queue anywhere. Full rationale, ordering rules and staleness policy in
`docs/LATENCY_POLICY.md`; measurements in `docs/PIPELINE_BENCHMARK.md`.

**Result** (matched A/B, same harness and machine state, only the constant
differing):

| Added latency | RTT | AI Hz 1 → 2 | Overlay age 1 → 2 |
| ------------- | --- | ----------- | ----------------- |
| 0 ms | 0.9 ms | 10.01 → 10.00 | 118 → 128 ms |
| 60 ms | 61.7 ms | 9.91 → 10.01 | 189 → 189 ms |
| 120 ms | 125.0 ms | **5.01 → 10.00** | **355 → 253 ms** |
| 200 ms | 207.0 ms | **3.34 → 6.67** | **536 → 385 ms** |

Superseded and stale result counters were zero in every run: no completion
arrived out of order, none exceeded the 700 ms discard ceiling.

**Why it was promoted.** The analysis rate doubles wherever round trip dominates,
overlay age falls about 29%, result age is unchanged (as it must be), and there
is no measured correctness cost. It also unblocks speed measurement: the
estimator requires at least 4 Hz sampling, and one frame in flight delivers only
3.34 Hz at 207 ms RTT, so speed was structurally impossible on a high-latency
path regardless of calibration quality.

**What was not done.** Depth was not raised beyond 2. The worker runs one CUDA
call at a time by design — an asyncio cancel cannot stop a running kernel — so a
third slot would queue work rather than overlap it, which is exactly the backlog
the request forbids.

## P2 — Detection and tracking evaluation — NOT COMPLETED

**Status: blocked on licensed traffic footage, not on effort.**

The repository's only permitted image is the upstream Ultralytics `bus.jpg`
sample, with recorded provenance. That single photograph establishes execution
and Python/browser parity — it cannot establish precision, recall, mAP, track
continuity or ID-switch behaviour on traffic. Reporting any of those numbers from
it would be fabrication.

A real evaluation set needs traffic video that is licensed for this use and, for
mAP, labelled. Selecting, licensing and labelling such a set is an integrator
decision with legal consequences, not something to do silently. No dataset was
downloaded, and no detection-quality metric is claimed anywhere in this release.

**Consequence for P5 and P10.** Because the current detector's real failure modes
are unmeasured, there is no evidence-based case for replacing or fine-tuning it.
The request is explicit that the detector must not be replaced without measured
reason, and that training must not run merely to claim custom AI. YOLO26s stays.

## P5 — Detector audit — measured, no change

Prior benchmarks on this GPU remain valid and were not re-run because nothing in
the model path changed:

| Mode | Model | PyTorch CUDA inference / total |
| ---- | ----- | ----------------------------- |
| fast | YOLO26n | 7.51 ms / 14.51 ms |
| balanced | YOLO26s | 7.64 ms / 15.17 ms |
| quality | YOLO26m | 9.43 ms / 17.37 ms |

The entire fast-to-quality spread is 2.9 ms of a cycle that now runs 100–230 ms:
under 3%. Model choice is an accuracy decision, and accuracy cannot be compared
without P2's evaluation set. Balanced (YOLO26s) remains, unchanged and default.

## P3 — Speed validation — tooling complete, field measurement outstanding

Implemented: `SpeedValidationSession` with MAE, median, p95 (suppressed below 20
trials), maximum and signed bias; JSON and CSV export with numeric columns kept
analysable; a recording drawer wired to whichever tracks currently carry a valid
measured speed. 14 unit tests cover the statistics, the refusals and the exports.

Design rules that keep the evidence honest: a pass the system could not measure
is refused rather than recorded as zero error; a reference speed must be positive
and finite; p95 stays null below 20 trials; bias is reported separately from
absolute error.

**Field accuracy remains NOT MEASURED.** It requires a mounted camera, measured
road geometry and independently measured vehicle speeds. The exact operator
procedure is in `docs/SPEED_VALIDATION.md`. This is the one gate that needs a
person, and it is labelled as such everywhere rather than estimated.

## P12 — Calibration quality — DONE

`calibrationQuality()` grades an accepted calibration Valid or Weak with named
reasons. `createCalibration()` already refuses anything failing a gate, so there
is no third "Invalid" state at this layer — an invalid calibration does not
exist as an object, and speed stays null with a reason.

The grade is deliberately sensitive to how the fit is determined: the drawer
collects four corners plus one independent check point that is never fitted, and
four points fit a homography exactly, so the fit residual is structurally zero
and carries no information. In that case the independent check is the sole
evidence and the grade rests on it alone. The fit residual only enters the grade
when more than four correspondences over-determine the system. The camera status
line now reads *weak calibration · re-measure* rather than *measured setup* when
a calibration only just passed.

## P4 — Licence plate detection and OCR — REMAINS DISABLED

**Status: architecture understood, validation impossible here, so not shipped.**

The request is explicit that plate OCR may be marked ready *only if actually
validated*, and that plate strings must never be invented. Validation requires
plate images that this project is permitted to use. There are none: the
repository contains one upstream sample photograph, and scraping or downloading
plate imagery would breach both the request's data rules and the project's
privacy posture.

Building the detector and OCR integration without any way to measure plate
detection recall, exact-match accuracy or character accuracy would produce
exactly the unvalidated surface the request forbids. The existing primary-source
research — candidate detectors, OCR engines, licences and their gaps — is
preserved in `docs/OPTIONAL_FEATURES_AUDIT.md` and remains the starting point.
Note that that audit assessed a *browser WASM* pipeline; a desktop-GPU worker
pipeline removes the WASM and IndexedDB constraints and would need its own
assessment.

Nothing was half-built. No plate field exists in reports, no plate text is
produced, and no plate capability is claimed.

## P6 — Paired viewer — unchanged, measurement first

The viewer's sampled-JPEG preview (default 1 Hz, maximum 2 Hz, 640 px long edge
maximum, 128 KiB hard cap) is unchanged. The request requires measuring the
viewer before considering WebRTC, and the P1 work changed the analysis path
rather than the preview path, so the viewer's characteristics are as previously
recorded. WebRTC was not implemented: it is a large change whose justification
depends on a viewer measurement that has not shown a problem.

## P24 — Wrong-way detection — NOT IMPLEMENTED

Correctly ordered behind latency, speed and plates. The trajectory geometry that
would support it now exists and is reliable, but shipping it would mean adding an
event type whose thresholds have never been exercised against real road
geometry — another unvalidated surface. Not started rather than half-done.

## Feature enablement summary

| Feature | Status |
| ------- | ------ |
| Traffic detection and tracking (YOLO26s 640, CUDA) | **Production-ready for hackathon** |
| Browser WASM fallback (YOLO26n 416/320) | **Production-ready for hackathon** |
| Bounded two-frame analysis pipeline | **Production-ready for hackathon**, measured |
| Native camera preview with transparent overlay | **Production-ready for hackathon** |
| Code-based pairing, viewer, temporary reports | **Production-ready for hackathon** |
| Calibration quality grading | **Production-ready for hackathon** |
| Speed measurement | **Ready only for qualified calibrated setups**; field accuracy unmeasured |
| Speed validation tooling | **Production-ready for hackathon**; no trials recorded yet |
| Detection quality metrics (precision/recall/mAP) | **Not measured** — no licensed evaluation set |
| Licence plate detection and OCR | **Disabled** |
| Wrong-way detection | **Not implemented** |
| WebRTC viewer transport | **Not implemented** |
| Custom fine-tuning | **Not run** |
