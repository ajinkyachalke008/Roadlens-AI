# Executed acceptance results

The September 2026 local-GPU request extends the previously verified browser application. Status applies only to the named layer. Protocol fixtures, desktop browsers, worker benchmarks and earlier releases do not prove physical-phone or cloud operation. All listed local checks, including real GPU E2E and split HTTPS/WSS smoke, passed. Publication and frontend redeployment are pending.

## Existing application requirements

| Test IDs | Observed status and evidence |
|---|---|
| T01 | Clean npm ci, model preparation, production build, typecheck and lint passed. Current core suites: 124 unit, 49 contracts and 61 real relay tests. |
| T02–T03 | Current actual browser ONNX 416/320, portrait/landscape and Python/browser parity passed 11/11 in 6.3 seconds. Exact completed JPEG/overlay pixels were checked in browser E2E. GPU model execution is reported separately below. |
| T04–T08 | Real relay tests cover random/expired/rotated codes, reservations, role handshake/deadlines, exact origins and cross-room isolation. Worker registration is a separate machine capability, not an application account. |
| T09 | Desktop Chromium camera tests use native getUserMedia with an explicitly simulated image-backed device and actual inference. No microphone is requested; denial/release are exercised. Physical rear-camera selection is not verified. |
| T10, T12 | Existing browser-mode camera/viewer/late-viewer flows passed with actual relay/inference. Full current GPU E2E passed actual 640/960 detection, paired viewer delivery and restart transitions. |
| T11 | Bounded tests cover socket congestion, independent fanout, one active analysis job, latest useful input and bounded maps/queues. GPU transport adds one in-flight request with no worker application queue. Sustained physical load remains untested. |
| T13–T21 | Deterministic tracking, crossings, calibration, independent check, background texture, irregular source-time motion, unavailable gates, persistence/dedup and frozen reports passed. This logic stays camera-side in both modes. Evidence is synthetic numerical/texture testing, not field speed accuracy. |
| T22 | Real observations and optional exact JPEG evidence appeared below video on paired browsers in prior E2E. The full GPU E2E also passed real report delivery and viewer review. |
| T23–T24 | Source snapshots, revision ordering/conflicts and viewer Noted confirmation passed. The relay has no report repository; GPU worker cannot mutate facts, calibration, policies or reviews. |
| T25 | JSON/CSV browser downloads and null/formula-escape/secret-exclusion tests passed. Explicit downloads are the user's retained copies. |
| T26–T28 | Current automated lifecycle, storage spies, roles and packet bounds passed. Persistence scan covered 35 modules and the privacy run passed 10/10. GPU protocol adds strict worker authentication and binary validation. Local tests do not audit provider access logs or physical OS behavior. |
| T29 | Real GPU combined-server restart passed: three local reports preserved, unavailable model assets caused visible fallback-load failure/pause, and explicit Resume after restoration succeeded. Old pairing expired immediately with close code 1008 and viewer state cleared. Automatic fallback during asset outage is not claimed. Deployed-provider restart remains not run. |
| T30 | Existing owner grace/reconnect/stale clearing passed. GPU worker loss transitioned to actual WASM and explicit worker retry returned to GPU in the current browser run. Connection-generation/cancel fencing has dedicated worker/relay tests. |
| T31 | Masked current GPU screenshots at 390-pixel mobile width and 1440-pixel desktop width were inspected. Prior browser layout checks and native dialog focus behavior remain documented. Physical touch/accessibility checks are not verified. |
| T32 | Vercel/Render/single-service configurations are prepared. Current compiled same-origin paired smoke passed 1/1 in 17.1 seconds and split HTTPS/WSS smoke passed 1/1 in 20.3 seconds. Existing https://roadlens-ai-five.vercel.app is frontend-only; current GPU publication/redeployment are pending and no cloud relay or GPU worker connection exists. |
| T33 | Partial: provider settings inspected read-only and application byte caps tested. Render creation remains blocked because the authorized account permits billable overages. Worker egress joins the same application caps; they are not a provider billing guarantee. |
| T34–T35 | Not verified: physical phone, cellular/second-network, sustained performance, thermal and memory behavior. Worker-only timing is not phone throughput. |
| T36 | Unmeasured: no field ground-truth speed dataset or error statistics. |
| T37 | Partial: 21 synthetic training safeguards passed in 0.133 seconds, and actual pretrained exports/parity passed. Local NVIDIA inference is separately verified. No custom training, traffic accuracy corpus, promotion or phone benchmark occurred. |
| T38 | Disabled: no OCR or plate feature is loaded. The GPU detector does not establish plate recognition. |
| T39 | Current pagehide/pageshow/BFCache, late HTTP, GPU startup/lease/encoding cancellation checks passed, including the complete 10/10 privacy rerun. Physical lock/background/permission revocation is not verified. |
| T40 | Real relay/client tests cover bounded snapshots, correlations, flood and cleanup. GPU leases retain at most one active or retired identity; no image or report history was added. |

## Optional GPU extension

| Gate | Result and scope |
|---|---|
| Runtime preflight | Actual CUDA convolution and neural inference passed on RTX 5070 Ti, Torch 2.14.0+cu130 and system CUDA toolkit 13.0.48. Python CPU fallback is disabled. |
| Model correctness | YOLO26n/s/m at 640 passed real-photo PyTorch/ONNX CUDA comparisons across six combinations, matching at IoU >0.99 and score delta <0.005. ONNX profiling recorded 290 CUDA nodes and zero CPU nodes. |
| Worker transport/lifecycle | 30 synthetic config/protocol/connection tests passed, including a real loopback WebSocket exchange with a synthetic detector. Covers bounds/identity, malformed input, registration, warmup gate, heartbeat, busy/no-queue behavior, cancellation/disconnection, backoff and same-thread cleanup. These are not GPU proof. |
| Current relay suites | 61 real HTTP/WS integration tests passed across existing and GPU paths. Covers separate worker authentication, owner-only lease, exact origins, cross-room roles, deadlines/retired identities, malformed frames and byte accounting. Detector replies in protocol tests are synthetic. |
| Worker aggregate | npm run test:worker passed 39 tests and 68 subtests in 6.06 seconds: transport/lifecycle tests, eight vision/GPU tests and one simulated preparation regression. Cached setup previously passed in 5.77 seconds. Actual CUDA cases were not skipped. |
| Normal Windows start | Actual start.ps1 from a nonproject directory passed CUDA warmup and relay registration. Two invalid configurations failed without secret output. Real Windows Ctrl+C stopped worker and all owned descendants and cleared the relay socket. |
| Repeatable launcher | Final npm run test:start rerun passed using a nonexistent temporary ConfigPath. Existing .env.worker was neither read nor changed; test secret stayed in process memory. |
| Cached setup | Full script exited 0 from a nonproject directory, reused pinned packages/checkpoints/ONNX artifacts, ran all worker tests and passed six five-run GPU benchmarks. Created only a missing ignored configuration template; preserved the original 20-run benchmark. |
| Worker benchmark | Five warmups and twenty measured runs passed for all six n/s/m PyTorch/ONNX combinations. Selected balanced PyTorch median: 7.40 ms inference, 13.88 ms total. One repeated permitted photo; excludes transport/browser/tracking and measures neither mAP nor field accuracy. |
| Browser GPU flow | Passed 1/1 in 22.5 seconds total, 18.6 seconds test time: actual CUDA and same-frame camera/viewer detections, 640/960 runs, viewer review, worker loss→actual WASM, worker restart→explicit GPU, combined-server restart/report preservation/visible pause/Resume, old-pairing expiry and End RAM cleanup. Zero browser console errors. |
| TensorRT | Unverified and unselected: no engine within the bounded five-minute build. Normal start does not rebuild engines. |
| Production/device | Not run/not verified: no deployed relay, public WSS worker connection, physical phone or cellular/second-network test. |
| Optional features | Training not run; OCR and wrong-way disabled. |

## Evidence and release totals

| Clean local release gate | Final observed result |
|---|---|
| Installation/preparation | Clean npm ci: 273 installed / 277 audited, zero audit findings; model preparation passed. |
| Build and static checks | Production build, lint and typecheck passed. |
| Unit/contracts/relay | 124 + 49 + 61 = 234 passed. |
| Browser model | 11/11 passed in 6.3 seconds. |
| General E2E | 10/10 passed in 1.6 minutes. |
| Privacy | 35-module persistence scan and 10/10 browser scenarios passed in 1.6 minutes. |
| Real GPU E2E | 1/1 passed in 22.5 seconds total. |
| Worker/startup | 39 tests plus 68 subtests passed; final real Windows startup/Ctrl+C rerun passed. |
| Compiled same-origin smoke | 1/1 passed in 17.1 seconds. |
| Split HTTPS/WSS smoke | 1/1 passed in 20.3 seconds. |
| Synthetic training safeguards | 21 passed in 0.133 seconds; no training ran. |
| Secret scan | Gitleaks 8.30.1: no leaks in 149 public text files. |

All listed local release checks passed. Ports 5173, 10000, 10002 and 10006 were not listening after verification. Publication and frontend redeployment remain pending; cloud relay/GPU, physical-phone and field-accuracy gates remain unresolved independently.

docs/evidence/gpu-browser-pipeline.json records the successful 2026-09-11T03:23:02Z run. At 640 pixels, 36 measured frames averaged 17.84 ms WebSocket result round trip excluding encoding, 8.97 ms inference and 13.94 ms worker processing. At 960 pixels, 26 frames averaged 20.29 ms round trip, 9.86 ms inference and 17.75 ms worker processing. Camera snapshots recorded result rates 9.397/7.930 Hz, source rates 14.94/14.83 Hz, processing times 27.2/42.7 ms and frame ages 21.5/36.5 ms respectively. These are short local replay measurements, not sustained phone/network performance or one-way latency.

Prior clean browser baseline: 106 unit + 34 contract + 33 integration = 173 tests, 11 real browser-model tests and nine E2E/privacy scenarios. Prior compiled same-origin and split HTTPS/WSS paired smokes each passed 1/1. Prior public frontend-only smoke passed 1/1 with local services stopped. These are baseline evidence, not current GPU aggregate results.

See GPU_RELEASE_RESULTS.md for reproduced failures/fixes, GPU_BENCHMARK.md for provenance/compatibility/performance, GPU_WORKER.md for actual startup/protocol behavior, and FINAL_HANDOFF.md for deployment and next actions. Earlier browser/measurement evidence remains in RELEASE_RESULTS.md, MODEL_VALIDATION.md, MEASUREMENT_RELEASE_AUDIT.md, RELAY_RELEASE_AUDIT.md and OPTIONAL_FEATURES_AUDIT.md. No unrun layer inherits another layer's PASS.
