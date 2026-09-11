# GPU release verification log

Initial clean main: `5917cb24d8c6540ce8f4649dafd8b46a55968e64`. The latest request authorizes an optional local GPU worker. Existing browser fallback, camera report authority, RAM-only transport and qualified-speed gates remain in force.

| Phase | Observed result |
|---|---|
| P0 baseline | Before edits: clean install, model preparation, typecheck, lint; 106 unit, 34 contract, 33 relay, 11 browser-model, 9 E2E and 9 privacy tests; build, compiled paired smoke and three deployment schemas passed. |
| P1 transport | 49 contracts and 61 real HTTP/WS relay tests pass, including worker authentication, owner-only lease, binary flood bounds, cross-room isolation, timeout/cancel fencing and byte limits. Synthetic worker responses in protocol tests are not CUDA proof. |
| P2 CUDA | Actual PyTorch and ONNX CUDA execution for YOLO26n/s/m at 640. ORT profile: 290 CUDA nodes, zero CPU nodes. Worker suite: 39 tests and 68 subtests pass, including real model parity. |
| P3–P5 browser integration | Full real GPU browser acceptance passed 1/1 in 22.5 seconds: actual camera-page replay, relay, CUDA, matching frames, paired viewer, report/review, 640/960 profiles, worker loss and restart, WASM fallback, relay restart, preserved reports and End cleanup. |
| P6 launcher | `npm run test:start` passes from a nonproject directory: two invalid configurations fail safely; real CUDA warmup and registration; genuine Windows Ctrl+C stops all owned descendants and clears the relay socket. |
| P7 setup/benchmark | Cached setup passes from another directory. Six five-run checks and the separate six-model/runtime 20-run benchmark completed. TensorRT did not produce an engine within five minutes; unverified and unselected. |
| P8 cloud | Updated application source cda1d9692e1c2fdb6b3cbf3095e51591103afa5d is published. Vercel frontend verified Ready/Production, 20-second build, 19 static assets; public browser smoke passed 1/1 in 9.0 seconds. Render creation remains blocked by the prior strict no-overage condition. No production GPU connection or full cloud smoke. |
| P9 device/field | Physical phone, cellular/second-network and sustained thermal behavior not verified. Field-speed accuracy unmeasured. |
| P10 optional | Plate/OCR and wrong-way disabled. Custom training not run. |

## Local end-to-end measurements

At `2026-09-11T03:23:02.066Z`, balanced YOLO26s PyTorch CUDA processed a permitted still-photo replay over loopback WS. The source browser ran in desktop Chromium. This is not a physical phone, moving-traffic evaluation or public WSS benchmark.

| Analysis image edge | Completed frames | Mean envelope bytes | Mean WS result round trip | Mean worker inference | Mean worker total | Camera result-rate snapshot | Camera processing snapshot |
|---|---:|---:|---:|---:|---:|---:|---:|
| 640 | 36 | 76,043 | 17.84 ms | 8.97 ms | 13.94 ms | 9.40 Hz | 27.2 ms |
| 960 | 26 | 73,982 | 20.29 ms | 9.86 ms | 17.75 ms | 7.93 Hz | 42.7 ms |

WS round trip uses one observer clock and excludes JPEG encoding. Camera measurements use the camera clock; source-rate snapshots were 14.94/14.83 Hz and result ages 21.5/36.5 ms. Snapshots are not whole-run averages. Every completed frame detected at least five relevant objects. JPEG quality adapts to the same 80 KiB target, so a larger edge does not necessarily produce more bytes or prove improved accuracy. The authoritative standalone warm benchmark remains 7.40 ms median inference / 13.88 ms worker total for balanced mode.

Inspected masked screenshots at 390 and 1440 pixels: synchronized detections visible, no horizontal overflow. Viewer loaded no ONNX assets. End cleared report records and all application storage probes remained empty. Browser page/console errors were zero in the passing run. Generated local evidence is in `docs/evidence/`, intentionally excluded from published source.

## Reproduced failures and fixes

- Same-origin GET configuration discovery omitted Origin and received 403. Added strict POST `{v:2}` for that read, retaining exact Origin checks and GET compatibility; real HTTP regressions pass.
- Brief rate/backpressure busy responses caused unnecessary WASM fallback. Successful-send spacing now survives source epoch changes; busy frames drop and back off without accumulating a queue. Model errors and deadlines still trigger fallback. Regression tests pass.
- A stalled JPEG encoder survived close. A two-second deadline now covers encoding, Blob reads and network work; close settles the operation and late callbacks cannot upload.
- Delayed status/lease preparation could outlive Pause or hidden-page loss. Capture generation checks fence late starts; the real-browser privacy regression passes.
- Relay restart invalidates capabilities. Policy close 1008 now expires pairing immediately, while transient 1006/1013 retain bounded reconnects. Synthetic client tests and actual process-restart acceptance pass.
- The combined-server test also interrupts static model assets. Failed fallback loading pauses visibly and preserves three reports; explicit Resume after service restoration succeeds. Split deployment retains a separate frontend, but production outage behavior remains untested.
- The inference badge made an old reconnect test selector ambiguous. A dedicated connection-state locator preserves the assertion. Its failed run also exhausted the unchanged room-creation window; the full suite is rerun from a fresh server.
- An unquoted Windows Python path failed through npm's command shell. The scripts now invoke the isolated interpreter through a Node launcher; `npm run test:worker` passes 39 tests and 68 subtests in 6.06 seconds.

Final browser/privacy, deployment and publication results are recorded in `FINAL_HANDOFF.md` and `STATUS.md`. Unrun external gates remain explicitly open.
