# Relay release audit — 2026-09-10

Scope: the existing RAM-only Express/ws relay, shared protocol, browser transport/image decoder and actual integration/E2E coverage. This is release hardening of the working application. No architecture, shared wire schema, dependency lock or deployment setting was changed by this audit.

## Reproduced and fixed

1. **A canceled request could disconnect the source.** With real HTTP/ws connections, a viewer requested a snapshot, disconnected, and the source then sent its legitimate in-flight response. The relay had deleted the correlation and closed the camera with `invalid_request`. The same race affected expiration, viewer revocation and evidence responses. The relay now retains only bounded, expiring response-correlation metadata for canceled/completed requests: at most 32 entries per room by default, no report/image content, expiry at most 55 seconds and never beyond room expiry. Correctly typed late responses are discarded. Unknown/cross-room responses, schema/role misuse and wrong evidence IDs for active requests still reject the sender.

2. **Owner-only reconnect omitted report resynchronization.** Viewer sockets can remain connected during the source's reconnect grace. Previously only a viewer reconnect requested a snapshot, so reports or review revisions saved in camera RAM during the outage never reached those surviving viewers. Owner hello now creates fresh server-bound snapshot requests for every connected viewer. Interrupted old requests are retired, and all report content still comes from the open camera. No server report repository or latest-frame cache was introduced.

3. **Two complete snapshots could overflow the camera's bounded queue.** Two simultaneous 200-report requests require 40 ten-report batches; the browser intentionally caps reliable queued controls at 32. The relay now dispatches one snapshot at a time per room and permits only one pending snapshot per viewer. A canceled active snapshot holds its dispatch slot until completion or the existing request deadline so its remaining batches do not overlap newly dispatched work. Other request types remain independently correlated and normal transport backpressure remains enforced.

4. **Configuration advertised defaults instead of effective caps.** `/api/config` now reports the same effective lower limits enforced by the relay. Its regression configures 32 KiB JPEG, two rooms and a 1 MiB room budget and checks the authenticated-origin, no-store HTTP response.

## Validation

`npm run test:integration`: **32 passed**, one file, **6.42 seconds**, recorded local start 18:41:04. The seven added tests use real accepted WebSocket connections and cover canceled/expired snapshot batches, revoked evidence replies, mismatched active evidence IDs, owner-only reconnect to two surviving viewers with missed report revisions, two complete serialized 200-report snapshots, one pending snapshot per viewer and the 32-entry retirement bound. Existing role/isolation/malformed-message/backpressure/byte-budget tests and the actual child-process restart test remained enabled.

`npx tsc -p backend/tsconfig.json --noEmit` and `npx eslint backend/src/relay.ts tests/integration/relay.test.ts` passed. The full snapshot transport regression uses explicit synthetic report fixtures and a controlled source clock; it establishes protocol/queue behavior, not browser inference or field accuracy.

After the effective-config fix, `npm run test:integration` passed **33/33** in **6.57 seconds**, local start **18:51:41**. Root `npx tsc --noEmit` and scoped ESLint passed before that one-line endpoint change; final combined checks belong to the integrator.

## Remaining validation and observations

- Actual browser owner-disconnect recovery and stop-sharing/re-pair retention passed the release E2E below. It compares the entire 200-report source/viewer arrays; arbitrary smaller-snapshot replacement is outside that scenario's evidence. No browser suite ran during the initial read-only source audit.
- Existing production smoke exercised the compiled single-origin fallback. A real split-origin static frontend/relay test must establish direct API/WS routing and CORS without Vite's proxy. The integrator owns that harness and cloud deployment.
- The browser JPEG decoder inspects SOF dimensions before decode and bounds work to one active plus newest pending image. Existing E2E compares the actual packet JPEG pixels and overlay coordinates from the same completed frame; no model mock is used.
- These local tests establish neither public HTTPS/WSS deployment nor physical-phone/cellular operation. No cloud URL or provider billing guarantee is inferred.

## Release browser investigations

The real reconnect/200-report UI scenario passed after correcting the test network fault to target only `/ws`. Closing every browser WebSocket also closed Vite's development HMR connection and could reload the camera. The corrected harness uses unchanged real relay traffic and rejects only source relay reconnection attempts during the fault; detector/report data are never substituted. A focused pass took 13.2 seconds and covered source-local review during outage, complete report equality, unchanged viewer socket, stop sharing, re-pair and End settings reset.

The expanded suite exceeded the relay's genuine three-room-creation-per-minute allowance. The failed UI explicitly showed `Too many rooms. Retry in one minute.` The cancellation scenario now waits a real 60.5-second window after earlier room attempts and verifies that its held real HTTP responses are 201/200. Production limits were not increased.

A separate cold-start failure was reproduced with installed Vite 8.3.0 using `ROADLENS_TEST_FORCE_OPTIMIZE=1` and `vite:deps` output. The initial dependency scan omitted the worker's runtime import. At 19:02:04 the logs showed `new dependencies found: onnxruntime-web/wasm`, then `optimized dependencies changed. reloading`. The camera's replay element reset to readyState 0, zero dimensions and loop=false, and the unchanged actual-inference assertion failed after 20 seconds. The integrator fixed this through explicit dependency prebundling; the final forced run below validates the fix. An attempted verified cache-directory removal was automatically rejected as `blocked by policy`; Vite's supported non-destructive `--force` startup option was used instead.

Seven of nine expanded scenarios passed in the diagnostic full run, including real 416-to-320 worker adaptation with a clearly synthetic 350ms message-delivery delay, BFCache form-state reset and Replay-to-native-getUserMedia using the explicit Chromium fake device. Download URLs are checked after their actual existing one-second revocation timer rather than prematurely asserting synchronous cleanup.

**Final release browser result:** after explicit ORT prebundling and quota-aware test scheduling, `$env:ROADLENS_TEST_FORCE_OPTIMIZE='1'; npm run test:privacy` passed the 32-module source scan and **all 9/9 browser scenarios in 1.4 minutes**. No optimizer reload, skipped test, fabricated detection or relaxed production cap was used. The full real camera-to-viewer scenario passed 13.8s and the owner reconnect/full200/stop-sharing/re-pair scenario passed 10.8s. Actual desktop model sample and code-free screenshots are in `docs/E2E_VALIDATION.md` and `docs/evidence/`. Production/cloud/physical-phone results remain separately owned and unclaimed here.
