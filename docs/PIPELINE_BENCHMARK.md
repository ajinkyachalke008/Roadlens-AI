# Live preview and analysis pipeline benchmark

Measured on September 11, 2026 with `node scripts/benchmark-pipeline.mjs`. Each run uses the actual browser camera page, the actual compiled relay process and the actual local NVIDIA worker (RTX 5070 Ti, YOLO26s 640, PyTorch CUDA FP32, `actualCudaOperation=true`, `cpuFallback=false`). The capture device is Chromium's synthetic camera at 20 FPS; a physical phone reports its own higher rate. Added latency is injected inside the page's `/gpu` WebSocket only, half each way, to emulate a hosted round trip. No relay, worker or measurement code is modified by the harness.

These are local emulated-path numbers. They are not physical-iPhone measurements and not field accuracy evidence.

## Before: analysed canvas as the picture

The stage drew each completed analysed frame into a canvas, so the visible picture could never refresh faster than inference completed.

| Added latency | Camera FPS | AI FPS | Visible picture Hz | Result age |
| ------------- | ---------- | ------ | ------------------ | ---------- |
| 0 ms          | 20.0       | 10.01  | 10.00              | 19 ms      |
| 120 ms        | 20.0       | 5.00   | 5.00               | 151 ms     |

## After: native live element with a transparent overlay

The `<video>` element is composited by the browser at the camera frame rate and the overlay canvas redraws on `requestAnimationFrame`. Analysis is unchanged: the same AI rate, the same result age.

| Added latency | Measured RTT | Camera FPS | AI FPS | Overlay redraw Hz | Overlay age | Result age | Encode | Worker total | GPU inference |
| ------------- | ------------ | ---------- | ------ | ----------------- | ----------- | ---------- | ------ | ------------ | ------------- |
| 0 ms          | 0.7 ms       | 20.0       | 10.01  | 165               | 118 ms      | 18 ms      | 3.6 ms | 11.8 ms      | 8.4 ms        |
| 60 ms         | 61.9 ms      | 20.0       | 8.27   | 165               | 199 ms      | 81 ms      | 4.9 ms | 12.6 ms      | 9.1 ms        |
| 120 ms        | 125.0 ms     | 20.0       | 5.01   | 165               | 355 ms      | 146 ms     | 4.4 ms | 13.5 ms      | 9.3 ms        |
| 200 ms        | 211.9 ms     | 20.0       | 3.45   | 165               | 525 ms      | 224 ms     | 4.4 ms | 12.7 ms      | 8.7 ms        |

All values are medians over 30 samples taken twice a second after a four-second settle. `165 Hz` is the headless Chromium animation rate; on a device the overlay redraws at the display refresh rate.

## What the numbers say

- **The GPU is not the bottleneck.** Inference is 8–9 ms of a cycle that runs from 100 ms to 290 ms. Decode, preprocess and postprocess together add about 4 ms.
- **Round trip sets the analysis rate.** With one frame in flight, analysis Hz tracks `1 / (round trip + ~25 ms)`: 10.0 Hz at 0.7 ms, 8.3 Hz at 62 ms, 5.0 Hz at 125 ms, 3.5 Hz at 212 ms.
- **Analysis was never the cause of a choppy picture, and the refactor did not change it.** The same AI rates appear before and after; only the visible picture changed, from 5–10 Hz to the camera's own frame rate with the overlay at display refresh.
- **The 10 Hz ceiling at zero latency is capture quantisation, not the GPU.** The adaptive controller settles at the 71.7 ms protocol floor (`GPU_LIMITS.maxHz` 15), and the 20 FPS synthetic camera can only satisfy it every second frame. A 30 or 60 FPS camera quantises finer.
- **Overlay age, not analysis Hz, is what the eye sees.** It is the age of the newest result against the live presentation clock. At 5 Hz a 350 ms old overlay is on time, which is why freezing is decided against measured cadence (`staleFactor` 1.6, floor 250 ms, ceiling 700 ms) rather than a fixed threshold, while the reported health bands stay absolute (<100 ms healthy, 100–250 ms degraded, >250 ms stale).

## Analysis payload encoding

Measured in the page on a 1280×720 frame, median of 12 encodes:

| Format       | Quality | Encode  | Bytes  |
| ------------ | ------- | ------- | ------ |
| `image/jpeg` | 0.75    | 6.2 ms  | 14,259 |
| `image/webp` | 0.75    | 27.7 ms | 6,988  |

WebP halves the payload and costs 4.5× the encode time on the capture device, where the main thread is also compositing the preview. With round trip rather than bandwidth setting the rate, that is the wrong trade. WebP would also require changing the wire format literal in `shared/src/gpu.ts`, the worker's `format` check, and the pre-decode JPEG SOF dimension guard in `worker/protocol.py` that rejects malformed images before any pixels are allocated. Not adopted.

## Worker model modes

`node scripts/worker-python.mjs -m worker.runtime.benchmark --iterations 20`, one permitted photo repeated, 640 input, same RTX 5070 Ti. All six configurations passed with real CUDA execution and the same five detections.

| Mode     | Model   | PyTorch CUDA inference / total | ONNX CUDA inference / total |
| -------- | ------- | ------------------------------ | --------------------------- |
| fast     | YOLO26n | 7.51 ms / 14.51 ms             | 5.56 ms / 13.51 ms          |
| balanced | YOLO26s | 7.64 ms / 15.17 ms             | 7.88 ms / 15.56 ms          |
| quality  | YOLO26m | 9.43 ms / 17.37 ms             | 15.42 ms / 24.51 ms         |

The whole spread between fast and quality is 2.9 ms of a 100–290 ms cycle: under 3%. A Fast/Balanced/Quality control is an accuracy control, not a smoothness control, and it cannot be a browser control at all today — the worker binds one model at process start from `ROADLENS_MODEL_MODE`, and there is no protocol message to change it. The mode therefore stays operator-selected at worker start, and the camera shows which model and runtime are actually connected. Balanced remains the default; the measurements give no reason to change it.

## Two frames in flight — measured and adopted

Measured September 11, 2026 as a matched A/B: the same harness, the same machine
state, the same 25-second runs back to back, with `GPU_LIMITS.maxInFlight` the
only difference between the two builds. Artifacts:
`docs/evidence/pipeline-ab-inflight1.json` and `pipeline-ab-inflight2.json`.

| Added latency | Measured RTT | AI Hz (1 → 2) | Result age (1 → 2) | Overlay age (1 → 2) | Superseded | Stale |
| ------------- | ------------ | ------------- | ------------------ | ------------------- | ---------- | ----- |
| 0 ms          | 0.9 ms       | 10.01 → 10.00 | 16 → 21 ms         | 118 → 128 ms        | 0          | 0     |
| 60 ms         | 61.7 ms      | 9.91 → 10.01  | 78 → 83 ms         | 189 → 189 ms        | 0          | 0     |
| 120 ms        | 125.0 ms     | 5.01 → 10.00  | 146 → 146 ms       | 355 → 253 ms        | 0          | 0     |
| 200 ms        | 207.0 ms     | 3.34 → 6.67   | 230 → 224 ms       | 536 → 385 ms        | 0          | 0     |

**Adopted: 2.** What the numbers say:

- **The gain is exactly where the model predicts it.** Where round trip dominates,
  the completed-analysis rate doubles: 5.01 → 10.00 Hz at 125 ms and 3.34 → 6.67 Hz
  at 207 ms. Where it does not — 0 ms and 60 ms, already pinned by the 71.7 ms
  protocol send floor and the 20 FPS synthetic camera's 50 ms quantisation —
  nothing changes, because there was nothing to win.
- **Overlay age falls by about 29%** at both high-latency points (355 → 253 ms,
  536 → 385 ms). This is what the eye actually sees.
- **Result age is unchanged**, as it must be. Depth does not shorten one frame's
  journey; it overlaps journeys. Any implementation that appeared to reduce result
  age would be measuring the wrong thing.
- **No correctness cost.** `superseded` and `stale` are zero in every run: not one
  completion arrived after a newer one had committed, and not one exceeded the
  700 ms discard ceiling. The ordering gate was never needed in these conditions,
  which is the point of having it.
- **It unblocks speed at high latency.** The estimator requires at least 4 Hz
  effective sampling with no gap over 350 ms. At 207 ms RTT one frame in flight
  delivers 3.34 Hz, so speed is refused as `sampling_too_sparse` no matter how
  good the calibration is. Two frames deliver 6.67 Hz, which clears the gate. On a
  hosted relay over cellular, depth is what makes measurement possible at all.

The 60 ms row is bimodal across runs (7.99 Hz in the earlier single-depth
baseline, 9.91 Hz here) because the adaptive interval lands near the 20 FPS
camera's 50 ms grid and can settle on either 100 ms or 150 ms spacing. That is an
artifact of the synthetic 20 FPS capture device, not of the pipeline; a 30 or
60 FPS camera quantises finer.

### Measured on the real hosted path

The same page against the deployed Vercel frontend and the deployed Render relay,
with the local RTX 5070 Ti worker connected outbound — no injected latency, the
actual hosted round trip (`node scripts/measure-production.mjs`):

| Relay build | RTT | Camera | AI Hz | Result age | Overlay age | GPU inference | Worker total | Depth | Superseded | Stale |
| ----------- | --- | ------ | ----- | ---------- | ----------- | ------------- | ------------ | ----- | ---------- | ----- |
| before deploy | 51.9 ms | 20.0 | 9.98 | 123 ms | 233 ms | 8.6 ms | 12.6 ms | 1 (downgraded) | 1 | 0 |
| after deploy | 58.4 ms | 20.0 | 9.51 | 123 ms | 230 ms | 8.9 ms | 12.5 ms | 2 | 0 | 0 |

The first row was taken while the frontend was deployed and the relay was not.
The client saw three refusals with a frame outstanding and settled permanently at
depth 1 — the graceful-degradation path, observed in production rather than only
in a test. After the relay deployed, the same client held depth 2 with no
refusals and no superseded results.

At ~50 ms hosted RTT the two are equivalent, exactly as the A/B predicts: this
path is still bounded by the 71.7 ms send floor and the 20 FPS capture grid, not
by round trip. The depth-2 gain is reserved for the slower paths — cellular, a
busier relay, a more distant region — where the A/B measured it doubling.

### Rollout ordering

The relay must be deployed before the frontend. A new relay accepts one or two
outstanding frames, so an old client is unaffected. A new client against an old
relay still works — the second frame is refused with `busy`, which the client
treats as a normal drop — but it pays a raised congestion floor for every
refusal, so it degrades rather than failing. Deploying the relay first avoids
that window entirely.

## One frame in flight — superseded, retained for history

`RemoteDetector` keeps one outstanding GPU frame, so analysis Hz is bounded by the full round trip, as the table shows. Raising that bound is not a client-side change: `backend/src/gpu.ts` rejects a second frame with `inference.error code=busy` while one is pending, and `worker/connection.py` does the same while native work is active. Two frames in flight therefore needs the browser client, the relay lease and the worker changed together, plus contract tests for the new ordering, and a version skew during rollout degrades to continuous `busy` drops. The measured gain would be real — roughly double the analysis Hz and half the overlay age wherever round trip dominates — so it is recorded here as the next measured step, not adopted in this release.
