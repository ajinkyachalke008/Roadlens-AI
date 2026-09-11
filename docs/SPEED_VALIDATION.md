# Speed validation

RoadLens speed is algorithmically tested and, as of this release, **not validated
against physical ground truth**. This document defines what the tooling records,
what may be claimed from it, and the exact procedure an operator follows to
produce real field evidence.

## What is already established

- **Algorithm.** Planar homography projection of each track's ground-contact
  point, then a median-of-pairwise-slopes (Theil–Sen style) velocity fit across
  in-zone observations, in source time. Implemented in
  `frontend/src/geometry/speed.ts`.
- **Synthetic validation.** Unit tests in `tests/unit/measurement.test.ts` drive
  the estimator with constructed trajectories and known homographies and assert
  recovered speed, rejection reasons and every gate. These prove the mathematics
  and the gates, not field accuracy.
- **Gates before any number is shown.** Stationary-camera confirmation, verified
  background, a valid measured calibration bound to the current capture epoch and
  frame geometry, confirmed and unambiguous track identity, at least 8 in-zone
  samples, at least 1.5 s of coverage, at least 4 Hz effective sampling with no
  gap over 350 ms, at least 3 m of displacement, a fit residual within
  `max(0.5 m, 10% of displacement)`, plausible motion and consistent direction.
  Any failure yields `speedMps = null` and a machine-readable reason.

## What is not established

Field accuracy. No MAE, median error, p95, maximum or bias has been measured
against an independent reference, because that requires a physical camera on a
real road with independently measured vehicle speeds. **The agent could not
perform this**, and no number in this repository should be read as if it had.

## Calibration quality

`calibrationQuality()` grades an accepted calibration:

- **Valid** — every informative gate passed with margin, each consuming under
  60% of its allowed tolerance.
- **Weak** — accepted, but a property is marginal, and the reason names it with
  its measured value and tolerance.

Which gates are informative depends on the fit. The calibration drawer collects
four road-plane corners plus a fifth **independent check point that is never
fitted**. Four points determine a homography exactly, so the fit residual is zero
by construction and carries no information; in that case the independent check is
the sole evidence and the grade rests on it alone. The fit residual only enters
the grade when more than four correspondences over-determine the system.

There is no "Invalid" grade at this layer because `createCalibration()` refuses
to produce a calibration at all when a gate fails; the failure is thrown with its
reason and speed stays `null`. Weak calibration is a prompt to re-measure, not a
reason to hide speed — but a validation trial recorded under a weak calibration
should say so in its notes.

## Recording trials

`SpeedValidationSession` (`frontend/src/validation/speedTrial.ts`) pairs each
measured pass with an operator-entered reference speed and computes MAE, median
absolute error, p95 (suppressed below 20 trials), maximum and signed bias.
Exports are JSON and CSV via `speedValidationJson` / `speedValidationCsv`.

Design rules that keep the evidence honest:

- A pass the system could not measure is **refused**, not recorded as zero error.
  A null estimate is a null estimate, never a data point.
- A reference speed must be positive and finite.
- p95 is `null` below 20 trials, because a p95 of six passes describes the six
  passes and not the system.
- Signed bias is reported separately from absolute error: a system reading
  uniformly 3% high is a different problem from one scattering ±3%.
- Numeric CSV columns are emitted as numbers so the export is analysable; only
  free text passes through the formula-injection guard.
- Trials live in session RAM only, exactly like reports. Ending the session
  clears them. Export before ending the session.

## Physical field procedure — operator action required

This is the single gate that needs a person. Do not perform any step from a
moving vehicle, and never interact with the phone while driving.

**1. Site.** Choose a straight, approximately flat, single-grade stretch with a
clear view of a 20–40 m section of road. Stand well off the carriageway, behind a
barrier or kerb. Do not obstruct traffic or stand on the road to place markers
while traffic is moving.

**2. Mount.** The camera must be stationary and rigid — a tripod or a clamp, not
a hand. Any camera motion invalidates measurement continuity, and RoadLens will
detect it and drop to `camera_moved`. Frame the road so the measurement zone
occupies the middle of the image, not the far distance.

**3. Geometry.** With traffic stopped or on a closed/private road, mark four
points on the road plane — the corners of a rectangle along the lane works well —
and measure their real separations with a tape or measuring wheel. Record every
distance in metres. Then mark one further point whose position you also measure
but which you enter as the **independent check**, not as a corner. Because the
four corners fit the homography exactly, this fifth point is the only
independent evidence that the geometry is right; choose it well inside the
measurement area rather than on the edge.

**4. Calibrate.** In the app, open Calibration, confirm the camera is mounted,
enter the four corner correspondences and the independent check, and draw the
measurement zone inside the marked area. The camera status line reads *measured
setup* when the calibration grades Valid and *weak calibration · re-measure* when
it does not. Re-measure before collecting trials if it reads weak — the check
point is the only thing standing between a mis-measured tape and a confident
wrong number.

**5. Reference speed.** Choose one method and use it for every pass; record it
with each trial:
   - *Timing gate* (most defensible, no extra equipment): two marks a measured
     distance apart, and a stopwatch. Requires a second person.
   - *GPS speedometer* in a cooperating driver's vehicle, read by a passenger,
     at a pre-agreed constant speed.
   - *Radar gun*, if one is available and its own calibration is known.
   Never read a speedometer while driving; that is the passenger's job.

**6. Passes.** Run at least **20 passes** so a p95 is meaningful, spread across
the speed range you care about (for example 30, 50 and 70 km/h) rather than all
at one speed. For each pass, wait until RoadLens shows a valid numeric speed for
that vehicle, then record the trial with the independently measured reference
speed and the method.

**7. Export.** Before ending the session, export the validation JSON and CSV.
Ending the session clears every trial permanently.

**8. Record.** Add the exported summary to this document with the date, site,
camera, mount, calibration quality, reference method and pass count. Only then
may a measured-accuracy claim be made, and only in the exact terms the export
supports.

## Claim boundary

Permitted once trials exist: "Over N passes at this site with this calibration,
measured MAE was X m/s (Y%), median Z m/s, bias B m/s."

Never permitted: enforcement-grade accuracy, certified or legal accuracy,
accuracy at a site or speed range that was not tested, or any accuracy figure at
all while the table below is empty.

## Measured results

**NOT YET MEASURED.** No physical field validation has been performed. This table
stays empty until an operator completes the procedure above.

| Date | Site | Passes | Reference method | Calibration | MAE | Median | p95 | Max | Bias |
| ---- | ---- | -----: | ---------------- | ----------- | --: | -----: | --: | --: | ---: |
| —    | —    |      0 | —                | —           |  —  |   —    |  —  |  —  |  —   |
