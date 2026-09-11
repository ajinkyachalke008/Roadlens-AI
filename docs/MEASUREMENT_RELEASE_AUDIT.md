# Measurement and report release audit

Observed September 10, 2026, Los Angeles. The initial audit was read-only during the integrator's clean baseline. It covered the active tracking, geometry, rules and session modules, their unit/contract tests, camera measurement wiring, calibration drawer and report interfaces. The release-hardening request, active repository instructions, shared contracts, model pipeline, lifecycle rules, status, acceptance results and handoff were read. The folder initially still had no Git metadata. No browser suite or field trial was run by this audit.

After the integrator completed its baseline, it authorized the scoped tracking/session fixes below. Only those modules, their assigned unit tests and this audit document were edited by the measurement specialist. Capture/page/component/shared changes remain owned by the integrator.

## Findings and scoped fixes

### MRA-1 — Unverified current frame leaked into later speed history

The audited `frontend/src/camera/capture.ts` called `tracker.invalidateMeasurements()` before `tracker.update()` whenever background verification failed. The update immediately appended that same unverified frame as a new observation. At the next verified frame it became eligible history. A read-only module reproduction cleared before the update at source time 750 ms, then supplied seven verified observations at 1,000–2,500 ms in 250 ms steps. The resulting history had eight samples beginning at 750 ms and returned a valid 10 m/s estimate over 1,750 ms. Only seven samples had verified background; the required eight-valid-observation gate was bypassed.

`TimeAwareTracker.update(input, sourceTimeMs, captureEpoch, measurementEligible = true)` now accepts an explicit eligibility flag. False clears prior measurement history and prevents the current observation from being appended, including for a new track. Detection association, IDs, velocity prediction and low-confidence recovery continue normally. The regression reproduces the original sequence: seven qualified samples now return null / `insufficient_samples`, and only the eighth qualified sample permits the expected synthetic estimate. A second regression checks low-confidence association while measurement is ineligible.

Integration requirement communicated to the capture owner: pass `calibration !== null && mounted && background === 'verified'` as the fourth argument. Remove the per-frame tracker reset from the unverified-background branch; the flag handles measurement continuity without damaging detection tracking. Keep `rules.invalidateContinuity()` and explicit `tracker.invalidateMeasurements()` when applying a new calibration. The module regression does not itself prove that capture wiring or a physical camera passed.

### MRA-2 — Lost tracks could hide current objects at capacity

The old tracker retained up to 100 lost identities for 1.5 seconds and refused to allocate a new observed identity while that array was full. A module reproduction initialized 100 cars, then supplied a single disjoint bus detection at score 0.99. The result contained 100 lost tracks and zero observed tracks, so the current bus count became zero despite the actual detection.

When a new detection qualifies for track creation and capacity is full, the tracker now retires the oldest unmatched lost identity. It never replaces an observed identity or rewinds the next-ID counter. The new regression keeps the 100-track cap, creates the bus as ID 101 and counts one currently observed bus. This preserves the existing tracker architecture and its high/low confidence association.

### MRA-3 — Report selection and qualification truthfulness

`SessionStore.save(..., trackId=999)` previously selected a different observed track when 999 was absent. The direct reproduction requested 999 and saved track 1. It now rejects a missing or predicted explicit selection and requires an observed track for candidate kinds. Automatic observations without an explicit selection still choose a current observed object or save a scene observation.

An empty-scene observation previously produced `speedMps: null` and `validityReasons: []`; the audited report drawer rendered its empty reason list as “Qualified estimate.” Empty-scene observations now have `no_observed_object`, retain null speed and remain useful observations. The integrator was also asked to condition that display fallback on numeric speed, since incoming schema-valid observations may still have an empty reason list.

`save` now validates the frame and policy before retaining evidence, and rejects a policy version different from the frame's frozen `policyVersion`. This prevents a future caller from attaching a newly edited policy to an older event frame. The current camera page already uses the completed frame's frozen policy for automatic and manual saves; that behavior should be preserved.

### MRA-4 — Pathological policy label can exceed report budget

Previous executed sizing tests used the actual YOLO26n manifest identity, UUID provenance, long source time, eight full-precision trajectory triples and optional evidence. Serialized reports measured 1,662 bytes with a normal road label, 1,709 bytes with an 80-character ASCII label and 1,869 bytes with an 80-character CJK label. They fit the 2,048-byte contract. An 80-NUL-character label was policy-schema-valid but serialized as escaped text, creating 2,109 bytes. The store safely rejected it before retaining evidence.

The integrator owns tightening the shared road-label schema and presenting a bounded report failure without stopping camera analysis. This audit did not relax the report cap, truncate event facts silently or modify shared schemas. Report-only trajectory rounding could save bytes if later necessary, but it is not required by the measured ordinary-label cases and was not introduced here.

## Executed scoped validation

After scoped changes:

- `npx vitest run tests/unit/measurement.test.ts tests/unit/session.test.ts`: **83 passed**, two files — 51 measurement and 32 session/export tests. Reported duration 228 ms.
- `npm run typecheck`: passed.
- `npx eslint frontend/src/tracking frontend/src/geometry frontend/src/rules frontend/src/session tests/unit/measurement.test.ts tests/unit/session.test.ts`: passed.

Read-only reproductions used `node --import tsx` with inline synthetic data and the actual modules. They did not invoke a browser, produce traffic footage or establish field accuracy. Whole-project, browser, production and cloud results belong to the integrator's subsequent ledger; this document does not promote the scoped results into a claim about those layers.

Existing numerical safeguards remain intact: normalized DLT with rank/conditioning checks, independent check, finite ROI projection, mounted/background checks, at least eight observations over 1.5 seconds, observed rate at least 4 Hz, no gap above 350 ms, at least three meters displacement, robust residual/direction checks and candidate persistence/hysteresis/dedup. No validity threshold was lowered.

## Wrong-way extension assessment

Keep wrong-way disabled for this release until the core fixes, full regression suites and release gates are green. It can reuse observed world-space trajectories and needs no additional neural model, but it still needs an explicit lane/zone direction configuration, permitted target classes, a nonzero direction vector, sufficient travel distance, strong sustained opposite-direction agreement, identity/background gates and an independent episode ledger. Parked/jittering objects, pedestrians when excluded by policy, startup, gaps and partial U-turns need rejection tests.

The current report schema names `wrong_way_candidate`, but that alone is not an implementation: the current policy has no lane direction, there is no wrong-way producer and the audited report drawer labels every non-observation as a speed candidate. Adding the rule without the policy, validation, provenance and display changes would be incomplete. No wrong-way claim or simulated wrong-way event was added by this audit.

## Safe manual field-speed protocol — prepared, not executed

1. Use a controlled permitted site and an ordinary safe operating speed. Keep people and equipment out of the vehicle path. Do not ask a driver to speed, drive the wrong way or perform an unsafe maneuver to create a report. A low operator-entered demo threshold is sufficient to exercise a candidate safely; keep that threshold explicitly labeled as a demo setting.
2. Mount the camera rigidly. Record device, OS/browser, detector profile and model hash. Measure road-plane correspondences with a physical reference, enter the zone, and check a distinct unused point or segment. Record calibration version, independent-check error, dimensions and mounting conditions. Revalidate after any movement, orientation, zoom, source or resolution change.
3. Use an independent reference instrument or independently timed measured-distance segment operated by the site team. Record its method, distance/timing uncertainty and per-pass reference value. Do not use RoadLens's own homography or object trajectory to manufacture its ground truth. Vehicle dashboard indications alone are not an independently validated reference.
4. Plan the number and safe speed range of passes in advance; record every attempted pass. Match each RoadLens observation to the correct reference pass and the same stable-speed road segment. Because RoadLens estimates motion over a window, do not compare it with an unrelated instantaneous speed from a different part of an accelerating/braking pass. Never subtract timestamps from different device clocks to infer one-way latency or speed.
5. For each pass record a pass ID, reference speed, RoadLens nullable speed, source time/frame/track IDs, model/profile/calibration/policy versions, available sample/coverage/residual facts and any unavailable reason or visible track ambiguity. Export only through the explicit local download action. Keep failures and null results in the table; do not replace them with zero or select only the most favorable estimates.
6. Convert both speeds to the same units. For each pass with a matched valid estimate compute `absolute_error_i = abs(estimate_i - reference_i)`. For `n` valid matched passes, `MAE = sum(absolute_error_i) / n`; median error is the middle sorted error, or the average of the two middle errors for even `n`; largest observed error is `max(absolute_error_i)`. If `n = 0`, these statistics are unavailable, not zero. Report attempted passes and unavailable counts/rate alongside these conditional error statistics. Keep device/profile/calibration groups separate when their conditions differ.
7. Report the actual sample size, setup, reference uncertainty and observed limitations. An independent geometry check or low error on a small controlled sample does not certify arbitrary field speeds or legal admissibility. Without the completed comparison, retain **real-field speed accuracy: UNMEASURED**.
