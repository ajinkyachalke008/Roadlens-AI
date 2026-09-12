# Detector audit

Whether the primary traffic detector contributed to the reported ID
fragmentation, and whether changing it improves the full system.

Measured on the actual deployment GPU. Reproduce with:

```
npm run gpu:benchmark -- --runtimes pytorch_cuda --models fast balanced quality
```

## Conclusion first

**Keep YOLO26s at 640.** No change is justified by evidence available here, and
the fragmentation this release set out to fix was proved to be a tracker defect
rather than a detection one.

## 1. Did the detector cause the fragmentation?

No. `docs/TRACKING_EVALUATION.md` §3 has the measurement: a single-variable
sweep over detector behaviour shows that dropout, box jitter, analysis cadence
and object size each produced **zero** identity switches on a clean traversal,
while class instability produced all of them — and the mechanism was
`time_aware_iou_v1`'s hard class gate severing identity on every `car`/`truck`
flip, not the detector failing to see the vehicle.

A larger model would not have fixed this. Class confusion between `car`, `truck`
and `bus` on SUVs, vans and pickups is characteristic of the COCO label set
itself, not of model capacity. The fix belonged in association, and that is
where it was made.

## 2. Latency, measured

RTX 5070 Ti 16 GB, PyTorch CUDA 2.14.0+cu130, driver 610.74, 20 iterations after
5 warmup, on `tests/fixtures/bus.jpg`. Full record:
`docs/evidence/gpu-benchmark-detector-audit.json`.

| mode | model | decode | inference (median) | inference (p95) | worker total | throughput |
| --- | --- | --- | --- | --- | --- | --- |
| fast | yolo26n-640 | 3.81 ms | 7.14 ms | 7.54 ms | 13.53 ms | 73.9 Hz |
| **balanced** | **yolo26s-640** | 3.88 ms | **7.15 ms** | 10.07 ms | **13.67 ms** | 73.1 Hz |
| quality | yolo26m-640 | 3.63 ms | 8.74 ms | 12.21 ms | 14.89 ms | 67.2 Hz |

The three models span **1.6 ms** of GPU inference and **1.4 ms** of worker
total. Against an end-to-end budget dominated by phone JPEG encoding, the relay
round trip and decode, that difference is not observable in the product. The GPU
is not the bottleneck, and "the RTX can handle more compute" is therefore not an
argument for anything.

## 3. Why no recall comparison is published

The release brief asks for vehicle recall, small-vehicle recall, motorcycle
recall, pedestrian recall and false positives per model. **Those numbers are not
reported here, because they were not measured.**

The only traffic imagery this project is licensed to redistribute is a single
photograph, which the benchmark harness itself flags:

> "One permitted photo, repeated; no field accuracy, motion or phone/network
> benchmark"

All three models return the same 5 detections on it. That is a smoke test, not a
recall comparison, and inventing a recall table from it would be exactly the
kind of unmeasured claim this release is meant to avoid.

Publishing a defensible comparison needs a labelled traffic set with per-frame
class presence. `docs/PHYSICAL_VALIDATION.md` describes how to capture one
legally; until it exists, the honest position is that **the relative recall of
YOLO26n / s / m on RoadLens traffic is unmeasured**.

## 4. Input resolution: 640 vs 960

The brief's hypothesis — that YOLO26s at 960 may beat YOLO26m at 640 for distant
vehicles — is plausible and **cannot currently be tested in this system**, for a
concrete reason:

`worker/protocol.py` requires `inputSize == 640`, and `worker/vision/detector.py`
letterboxes every frame to 640×640. The client's "GPU analysis image" setting
changes only the JPEG that leaves the phone.

So selecting 960 today sends roughly double the bytes over the phone uplink and
the Render relay, and the model still runs at 640. The only real benefit is a
less double-compressed source for the worker to downscale.

The UI overstated this: it offered "960 · more detail". That has been corrected
to "960 · sharper source, same 640 input", with a note stating plainly that the
model runs at 640 either way. An honest label costs nothing; a misleading one
invites an operator to pay double the bandwidth for a detail gain that does not
exist.

Testing 960 properly means a second set of hash-pinned artifacts, a protocol
change to negotiate input size, and a labelled set to measure the gain. That is
a detector release, not part of a tracking and product-behaviour pass, and it is
recorded here as the next detector work rather than half-done now.

## 5. Quality modes

`fast` / `balanced` / `quality` already exist in `worker/config.py` as
`ROADLENS_MODEL_MODE`, selecting yolo26n / yolo26s / yolo26m, all at 640, all
hash-pinned in `worker/model-catalog.json`.

They are deliberately **not** promoted to an in-session UI control:

- switching models mid-session would change `modelSha256` under live tracks,
  and the client correctly tears down the GPU connection when the descriptor
  changes;
- there is no measured quality difference to choose between (§3), so a UI
  control would ask the operator to pick on latency differences of about a
  millisecond;
- the mode is a worker deployment decision, set once before a session.

What the UI does do is report the model actually in use — `modelId`, runtime and
input size come from the worker's descriptor and are displayed verbatim, so the
displayed model is always the one that ran.

## 6. What would change this decision

- A labelled traffic set showing a real recall gap, particularly on small
  distant vehicles and motorcycles.
- Evidence that end-to-end result age is GPU-bound rather than
  network/encode-bound. It currently is not: 13.7 ms of worker time sits inside
  a much larger round trip.
- A 960 input path with pinned artifacts and a negotiated `inputSize`, measured
  end-to-end including phone encode and relay bytes.
