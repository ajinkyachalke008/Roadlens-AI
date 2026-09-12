# Tracking evaluation and the v1 → v2 decision

Why one physical vehicle was collecting several track IDs, what actually caused
it, what was changed, and what the change measures.

Reproduce everything here with:

```
npx vitest run tests/tracking
```

## 1. The report

An operator following a single car saw it labelled `car #7`, then `car #30`,
then `car #64`. Two readings of that were possible:

- the capture epoch was resetting, or
- association was failing and new identities were being minted continuously.

The observation itself rules out the first. `nextId` restarts at 1 on every
epoch reset, so an epoch reset produces *low* numbers, not rising ones. Rising
IDs mean no reset happened and roughly fifty new identities were created while
one car crossed the frame.

## 2. The evaluation set

Identity metrics need per-frame ground-truth association. Hand-labelling phone
footage frame by frame would have produced a smaller, less reproducible and
less legally clean set than generating the exact motion regimes the product
meets, so the set is synthetic and seeded: `tests/tracking/scenarios.ts` builds
trajectories, and a detector noise model adds box jitter, dropout, confidence
variation and class flips on top.

Two tiers, 23 scenarios:

- **Correctness tier** (`suite.ts`, 16 scenarios) — one car across 60+ frames,
  fast lateral motion, a distant box smaller than its own per-frame travel,
  1/2/5-frame misses, a confidence dip, partial occlusion, crossing vehicles,
  parallel lanes, an approaching vehicle, car/truck class wobble, a motorcycle,
  leave-and-re-enter, 5 Hz cadence, and mixed traffic. Every modern tracker
  should pass this; one that does not has a real defect.
- **Hard tier** (`stress.ts`, 7 scenarios) — a six-car queue, opposing lanes, a
  full second of occlusion, one frame in four dropped, 3 Hz cadence, four
  distant vehicles closer together than their own travel, and stop-and-go. This
  tier exists to rank trackers and, above all, to expose false merges.

The cadence parameter matters more than anything else in the model. RoadLens
tracks on *analysis* frames, not camera frames: the bounded two-frame GPU
pipeline delivers 5–12 Hz while the preview runs at 30–60. Inter-frame
displacement is therefore large, which is the regime where IoU-only association
fails.

### Metrics

`tests/tracking/metrics.ts` implements CLEAR-MOT matching at IoU ≥ 0.5 with
correspondence preservation, plus:

| metric | meaning |
| --- | --- |
| `idsPerGroundTruth` | distinct track IDs one physical vehicle collected. **1.00 is the product goal.** |
| `idSwitches` | CLEAR-MOT identity switches |
| `fragmentations` | interruptions of an already-tracked trajectory |
| `falseMerges` | one track ID covering more than one physical vehicle |
| `idf1`, `mota` | standard identity and accuracy summaries |

`falseMerges` is the safety metric: a tracker can drive `idSwitches` to zero by
absorbing its neighbours, and that is strictly worse than fragmenting.

## 3. What actually caused the fragmentation

`time_aware_iou_v1` was instrumented (`frontend/src/tracking/diagnostics.ts`,
opt-in sink, null in production) to record every refused association and the
reason. Over the correctness tier:

```
NEW-IDENTITY CAUSES
class_mismatch           21
no_candidate_track       17   (legitimate first appearances)
motion_gate               6
iou_below_gate            1
all_candidates_gated      1
```

A single-variable sensitivity sweep on one clean traversal isolates it further:

| varied input | ids/vehicle | ID switches |
| --- | --- | --- |
| clean, 10 Hz | 1.00 | 0 |
| class flips 3% | 2.00 | 2 |
| class flips 8% | 3.00 | 10 |
| dropout 10% | 1.00 | 0 |
| box jitter 6% | 1.00 | 0 |
| cadence 5 Hz | 1.00 | 0 |
| cadence 3 Hz | 1.00 | 0 |
| small box (0.05) | 1.00 | 0 |

**Dropout, jitter, cadence and object size caused no identity switches at all.
Class instability caused all of them.**

The mechanism is one line in v1:

```ts
if (t.className !== d.className || overlap < 0.15 || ...) return 1e6;
```

An SUV, van or pickup alternating between `car` and `truck` — completely normal
detector behaviour — had its identity severed on every flip, and the resulting
detection then minted a new ID. Fifty switches over sixteen scenarios.

**Verdict for the release report: the fragmentation is a tracker defect,
triggered by normal detector class instability. It is not a detector recall
problem, and no larger model would have fixed it.**

## 4. The candidates

`time_aware_iou_v2` was measured against reference implementations of ByteTrack
(Zhang et al., ECCV 2022, arXiv:2110.06864, MIT) and BoT-SORT (Aharon et al.,
2022, arXiv:2206.14651, MIT), written from the published algorithm descriptions
in `tests/tracking/reference.ts`.

Both are **motion-only** here, and that limitation is deliberate rather than
convenient: BoT-SORT's appearance ReID branch needs a second network producing
per-box embeddings, and RoadLens receives boxes from a remote worker while
tracking in the browser, so no embeddings exist on the tracking side. Its global
camera-motion compensation likewise needs the image, which the tracker never
sees. What is compared is the motion core of each: Kalman state, association
cascade, buffering policy.

### Browser-side or worker-side?

Tracking stays in the browser. Moving it to the GPU worker would have meant:

- source timestamps stop being authoritative, because the worker sees arrival
  order and RoadLens deliberately measures speed from browser-local frame
  presentation time;
- out-of-order results become much harder to keep out of track history, since
  the ordering gate that protects it lives in `CameraCapture`;
- browser fallback loses tracking entirely when the worker is gone.

Python library convenience is not a reason to give up any of those.

## 5. Results

### Correctness tier

| tracker | ids/gt | worst | idsw | frag | merges | IDF1 | MOTA |
| --- | --- | --- | --- | --- | --- | --- | --- |
| time_aware_iou_v1 | 2.01 | 3 | **50** | 26 | 0 | 0.914 | 0.901 |
| bytetrack_reference | 1.00 | 1 | 0 | 26 | 0 | 0.974 | 0.955 |
| botsort_reference | 1.00 | 1 | 0 | 26 | 0 | 0.974 | 0.955 |
| **time_aware_iou_v2** | **1.00** | **1** | **0** | 26 | 0 | 0.974 | 0.955 |

Every scenario went to exactly one ID per vehicle. `class-wobble` alone went
from 8 switches to 0.

### Hard tier

| tracker | ids/gt | worst | idsw | frag | merges | IDF1 | MOTA | MT/ML |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| time_aware_iou_v1 | 2.29 | 4 | 73 | 64 | 5 | 0.897 | 0.821 | 19/0 |
| bytetrack_reference | 1.11 | 2 | 3 | 70 | 2 | 0.920 | 0.861 | 17/0 |
| botsort_reference | 1.21 | 3 | 6 | 70 | 4 | 0.912 | 0.857 | 17/0 |
| **time_aware_iou_v2** | **1.11** | **2** | **3** | **64** | 3 | **0.938** | **0.899** | **19/0** |

v2 matches ByteTrack on identity switches, beats BoT-SORT on everything, and
leads both on IDF1, MOTA, fragmentation and mostly-tracked.

### The one place v2 is not best

`small-and-crowded` — four vehicles 4.5% of frame width, spaced barely wider
than their own per-frame travel, with 10% dropout and heavy jitter — is the only
scenario producing merges, and v2 has 3 there against ByteTrack's 2. The set was
built to contain a genuinely ambiguous scene, and this is it.

That residual is contained rather than hidden. `tests/tracking/safety.test.ts`
asserts that the tracker flags ambiguity in exactly that scene, and that an
ambiguous track carries an empty measurement window. Speed, directed counts and
candidate events are all gated on a track being confirmed *and* unambiguous, so
a merge in an ambiguous crowd cannot become a speed reading or a report.

## 6. Why v2 rather than adopting ByteTrack

v2 ties or beats ByteTrack on every aggregate metric, and it keeps three things
ByteTrack's formulation does not have:

1. **Variable cadence.** ByteTrack predicts one frame ahead at a fixed rate.
   RoadLens's analysis interval moves with GPU and network conditions, so v2
   predicts over the actual elapsed source time and gates on it.
2. **The measurement contract.** `observations`, `ambiguous` and the
   confirmed/lost states are what the speed estimator, the candidate rules and
   the directed counter consume. They survive unchanged.
3. **Source-time authority.** An update that does not advance source time is
   refused without touching existing identities.

## 7. What changed in v2

Each change answers a measured failure, not a hunch:

- **Class is a decayed, score-weighted vote**, and a mismatch inside a
  confusable group (`car`/`truck`/`bus`, `motorcycle`/`bicycle`) costs 0.12 of
  cost instead of ending the track. `person` is never grouped with a
  two-wheeler, because counts depend on that distinction. *This is the fix for
  the dominant failure.*
- **Scale- and motion-aware gating.** The centre gate is the track's own box
  diagonal plus its predicted travel, never below what its own motion requires.
- **Combined cost** — overlap, centre distance and scale — so association
  survives the zero-overlap frames that low cadence produces.
- **Smoothed, bounded velocity**, so one noisy step cannot throw the prediction.
- **Two-stage association**: low-confidence detections may continue a track but
  never start one (ByteTrack's contribution; fixes the confidence dip).
- **Bounded lost-track reactivation** (1200 ms).
- **An out-of-order update is refused, not obeyed.** v1 wiped every track when
  source time failed to advance; v2 returns the current view untouched.

### Tuning

`maxCost = 0.72` and `gateDiagonals = 0.9` come from a sweep over all 23
scenarios (`tests/tracking/sweep.test.ts`), not from one clip. Every combination
of `maxCost ∈ [0.68, 0.80]` and `gateDiagonals ∈ [0.6, 1.2]` scores identically;
0.72/0.90 sits in the middle of that plateau.

One cell, `maxCost = 0.62` with `gateDiagonals = 0.90`, scored better still — 2
switches and 1 merge against 3 and 3 — and **was rejected**: all four of its
neighbours are worse, and a sharp optimum on synthetic motion is tuning noise,
not a better tracker.

A crowd-aware gate that tightened association near neighbours was also built,
measured and **removed**. Capping the gate below a track's own predicted travel
refuses the track its own detection, which mints a new identity, which crowds
the scene further: identity switches went from 3 to 107 and merges from 3 to 22.
The failure is recorded in the tracker's comments so it is not re-attempted.

## 8. Regressions

`tests/tracking/regression.test.ts` asserts an exact identity-switch count for
all 21 named scenarios plus: 60-frame continuity, no identity recycling across
leave-and-re-enter, track expiry, epoch reset, refusal of an out-of-order update
(contrasted directly against v1's behaviour), no identity from a low-confidence
detection, and frame-relative motion reporting.

## 9. Limitations

- The evaluation set is synthetic. It models detector noise measured from
  RoadLens behaviour, but it is not filmed traffic, and it cannot substitute for
  the physical test in `docs/PHYSICAL_VALIDATION.md`.
- Identity is claimed **only while a vehicle is continuously observed**. A
  vehicle that fully exits and returns is a new identity, deliberately: nothing
  here does cross-time re-identification, and the product does not claim to.
- Merges in genuinely ambiguous crowds are reduced, not eliminated. They are
  flagged ambiguous, which blocks measurement, rather than silently trusted.
- IDF1 and MOTA are computed on this set only. They are not comparable with
  MOT17/MOT20 leaderboard numbers and are not presented as such. HOTA is not
  implemented.
