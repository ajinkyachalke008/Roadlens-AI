# Executed acceptance results — September 10, 2026

This records the implementation run against the supplied acceptance matrix. PASS is scoped to the named test layer. Browser contexts use desktop Chromium; none are a physical phone. Full command totals and final release status are in `STATUS.md` and `FINAL_HANDOFF.md`.

| Test IDs | Observed status and evidence |
|---|---|
| T01 | PASS: locked npm build/typecheck/lint and no-persistence source scan. No initial Git repository or app existed. |
| T02–T03 | PASS: actual ONNX416/320, portrait/landscape, Python/browser parity and production worker. Exact completed JPEG/overlay pixels compared in E2E. DPR behavior covered by rendering normalized coordinates; no physical display measurement. |
| T04–T08 | PASS: real relay integration covers random code format, wrong/expired/rotated invitations, pending reservations, role handshake/deadline, exact origins and isolation. |
| T09 | PASS desktop: full Chromium simulated camera uses native getUserMedia with an actual image-backed video device, no microphone, genuine model and track release. Denial visible. Physical rear-camera choice remains NOT_RUN. |
| T10,T12 | PASS: independent camera, viewer and late-viewer contexts run actual relay and detector; matching image/boxes, sequence and stale-state guards. |
| T11 | PASS bounded tests: native bufferedAmount injection, independent fanout drop, one-active/one-latest decoder/inference, maps/queues. Sustained physical memory/load remains NOT_RUN. |
| T13–T21 | PASS deterministic tracking, crossings, calibration, independent check, textured/background fixtures, irregular source-time motion, unavailable gates, persistence/dedup and frozen report facts. Synthetic numerical/texture evidence only. |
| T22 | PASS: real observation and optional exact JPEG evidence appear below video on both clients. |
| T23–T24 | PASS: source snapshots, revision ordering/conflict tests and actual viewer Noted confirmation; relay retains no report repository. |
| T25 | PASS: JSON/CSV browser downloads plus null/formula-escape/secret-exclusion unit checks. |
| T26–T28 | PASS automated local lifecycle/storage spies/role abuse/packet bounds. No content logger exists. Provider access logs and physical operating-system behavior are not audited by local tests. |
| T29 | PASS actual local process restart: old room/code/token invalid. Camera-local reports are retained by design on lost sharing; deployed-provider restart and restoration still NOT_RUN. |
| T30 | PASS: owner grace, reconnect and paused/stale clearing in integration/UI tests. |
| T31 | Desktop and phone-width Chromium layout checks and code-free screenshots in `docs/evidence`; native dialogs use browser focus containment/restoration. Physical touch/accessibility audit NOT_RUN. |
| T32 | Deployment configs validated; compiled local production and worker smoke are separate from cloud. Local production split HTTPS/WSS also passes. Public paired hosting remains BLOCKED by Render authorization. Frontend-only https://roadlens-ai-five.vercel.app is deployed and passes real dual-profile/local-report smoke. |
| T33 | PARTIAL: accessible account plans/usage recorded read-only; fanout budget exhaustion passes. Account-level free-only/no-overage assurance remains unresolved. |
| T34–T35 | NOT_RUN: no physical phone/cellular/second-network trial or sustained phone benchmark. |
| T36 | UNMEASURED: no field ground-truth speed dataset. |
| T37 | PARTIAL:21 synthetic dataset/resume/promotion safeguard checks, local GPU preflight, actual pretrained dual-profile export/parity; no authorized dataset, custom training, promotion or phone benchmark. |
| T38 | DISABLED: no OCR or plate feature loaded. |
| T39 | PASS automated pagehide/pageshow/BFCache lifecycle and late HTTP response cancellation; physical lock/background/permission revocation remains NOT_RUN. |
| T40 | PASS real relay and bounded-client tests for snapshots, request correlations, flood and cleanup. |

Public release evidence: `RELEASE_RESULTS.md`, `MODEL_VALIDATION.md`, `MEASUREMENT_RELEASE_AUDIT.md`, `RELAY_RELEASE_AUDIT.md` and `OPTIONAL_FEATURES_AUDIT.md`. Earlier detailed implementation records remain preserved locally. No unrun layer inherits another layer's PASS.

Release retest:106 unit +34 contracts +33 integration =173 passed;11 actual browser-model tests;9 E2E/privacy;1 compiled same-origin and1 split HTTPS/WSS paired smoke. Source scan32modules and21 training-safety tests pass. Source-authorized publication is separate from the still-blocked Render/phone/field gates.
