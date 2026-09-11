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

## One frame in flight

`RemoteDetector` keeps one outstanding GPU frame, so analysis Hz is bounded by the full round trip, as the table shows. Raising that bound is not a client-side change: `backend/src/gpu.ts` rejects a second frame with `inference.error code=busy` while one is pending, and `worker/connection.py` does the same while native work is active. Two frames in flight therefore needs the browser client, the relay lease and the worker changed together, plus contract tests for the new ordering, and a version skew during rollout degrades to continuous `busy` drops. The measured gain would be real — roughly double the analysis Hz and half the overlay age wherever round trip dominates — so it is recorded here as the next measured step, not adopted in this release.
