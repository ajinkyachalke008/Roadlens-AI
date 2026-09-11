# Analysis latency policy

This document defines the bounded analysis pipeline, the exact result-age bands
and the ordering rules that protect measurement. It is the reference for
`GPU_LIMITS.maxInFlight`, `GPU_LIMITS.maxResultAgeMs` and the gates in
`frontend/src/camera/capture.ts`.

## Why the pipeline is depth-bounded, not rate-bounded

GPU inference is 8–13 ms of an analysis cycle that runs from 25 ms to 230 ms.
The cycle is almost entirely round trip: camera → relay → worker → relay →
camera. With a single frame in flight, the completed-analysis rate is therefore
pinned at `1 / (round trip + ~25 ms)` no matter how fast the GPU is.

Raising throughput is a depth change, not a rate change. Each stage admits at
most `GPU_LIMITS.maxInFlight` (2) outstanding frame identities:

| Stage  | Enforcement                                                          |
| ------ | -------------------------------------------------------------------- |
| Camera | `RemoteDetector.pending` map; a frame past the bound is dropped       |
| Relay  | `pending` map in `backend/src/gpu.ts`; beyond it replies `busy`       |
| Worker | one active CUDA call plus one waiting slot in `worker/connection.py`  |

No stage queues. A frame that cannot be admitted is dropped immediately and the
next camera frame is considered on its own merits, so the newest useful frame is
always the one submitted. On the worker, a third frame displaces the waiting one
and the displaced identity is released as `busy` at once — depth never exceeds
two, and the older waiting frame is never the one preserved.

## Ordering is a correctness gate, not an optimisation

Several frames in flight means a completion can arrive **after** a newer one has
already been committed. Committing it would rewind track history and corrupt
every source-time-derived quantity. Two gates prevent this:

1. **Relay admission.** A frame is admitted only if its `frameSeq` and
   `sourceTimeMs` are strictly greater than the previous admitted identity in the
   same `captureEpoch`. Results are correlated by exact `frameId`, never by
   arrival order.
2. **Camera commit.** `CameraCapture` records `lastCommittedSeq`. A completion
   whose `frameSeq` is not strictly greater is counted as **superseded** and
   discarded before tracking, speed, rules, counts, evidence or display. A second
   check after JPEG encoding stops the display stepping backwards.

Consequences that hold by construction:

- The tracker only ever sees strictly increasing source time within an epoch.
- No interpolated or predicted overlay geometry reaches measurement; display
  smoothing remains display-only.
- Network completion order cannot reorder source-time history.

## Result-age bands

Result age is measured on **one clock** — the camera's — from capture to the
arrival of that frame's result. It is never inferred across unsynchronised
clocks.

| Band     | Age          | Behaviour                                             |
| -------- | ------------ | ----------------------------------------------------- |
| Healthy  | < 100 ms     | Normal operation                                      |
| Degraded | 100–250 ms   | Normal operation; reported as degraded                 |
| Stale    | > 250 ms     | Reported as stale; still tracked and measured          |
| Discarded| > 700 ms     | Dropped entirely: not displayed, tracked or measured   |

The reported bands are absolute, while the overlay's freeze decision is made
against measured cadence (`staleFactor` 1.6, floor 250 ms, ceiling 700 ms): at
5 Hz a 350 ms old overlay is on time, and freezing it would be wrong.

`GPU_LIMITS.maxResultAgeMs` (700 ms) is the hard discard ceiling, set at the
overlay staleness ceiling because a result older than that can never be
presented as live. Note what it is **not**: delay alone does not invalidate a
measurement. Speed is `Δdistance / Δ(source time)`, so a late result with a
correct source time is still geometrically valid. The ceiling is a deliberate
safety bound on how far behind live the system will act, not a claim that older
geometry is wrong. Between 250 ms and 700 ms the result is honestly labelled
stale and still used; beyond 700 ms it is discarded and counted.

A discarded result never creates a violation candidate, because candidates are
produced only from a committed frame.

## Adaptive submission

The controller minimises **result age**, not nominal FPS. To hold `maxInFlight`
frames outstanding on a measured cycle of `age`, it targets a submission
interval of `age × 1.15 / maxInFlight`, floored at the protocol send-rate floor
(`1000 / maxHz + 5` ms) and clamped to 1000 ms. Drops raise a congestion floor
multiplicatively; completions decay it. The result is that a degraded path sheds
submission pressure instead of building backlog.
