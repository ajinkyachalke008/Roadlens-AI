# Handheld absolute speed: research, and why it is not shipped

**Status: DISABLED. Not implemented, not behind a flag, not present in the
build.**

## The question

Can RoadLens report a vehicle's road speed in mph while the operator holds the
phone, walks, or pans?

## Why the current method cannot

Speed comes from a homography mapping the road plane to image coordinates, fixed
at calibration. A track's image positions are projected onto that plane and
differentiated against source time.

The homography is only valid while the camera pose is the one that was
calibrated. Under a moving camera, the projected trajectory of a **parked** car
is indistinguishable from that of a moving one: what is measured is relative
motion between camera and vehicle, and the method has no way to separate them.

The failure is not noise. A pan of a few degrees per second produces a large,
smooth, entirely plausible-looking mph number for a stationary vehicle. It would
pass every existing validity gate — residual, direction consistency, sample
count — because the motion genuinely is smooth and straight. **A wrong number
that survives the quality checks is worse than no number.**

## What would be required

Compensating camera motion needs the camera's own metric velocity, not just its
rotation.

| approach | what it gives | why it is not sufficient here |
| --- | --- | --- |
| Device IMU (`DeviceMotionEvent`) | angular rate, linear acceleration | Rotation compensation is achievable. Translation is not: consumer accelerometers double-integrate into metres of drift within seconds, and iOS requires a user gesture for permission and serves it only over HTTPS. Rotation alone does not solve the problem — a walking operator translates. |
| WebXR (`immersive-ar`) | 6-DoF metric pose from the platform's own VIO | The right primitive, and the only one that yields metric translation in a browser. Not available in iOS Safari, which is the platform this release was fixed for. Android/Chrome support exists but would ship a speed feature that silently does not exist on half the devices. |
| ARKit | 6-DoF metric pose, plane estimation | Native only. RoadLens is a web app; adopting it means a native app, which is a different product. |
| Visual odometry / SLAM in the browser | camera trajectory up to scale | Monocular VO is scale-ambiguous by construction. Scale must come from somewhere else — a known object size, IMU fusion, or a plane at known height — and each reintroduces a calibration the handheld case was trying to avoid. Also a substantial per-frame compute budget on a phone already running camera capture and an overlay. |
| Metric monocular depth (Depth Anything V2 metric, UniDepth, Metric3D) | per-pixel metric depth | The most promising direction, and genuinely improving. But the error that matters is depth error *across the measurement window*, since speed is a difference of positions: a few percent of relative depth error on a vehicle 40 m away is metres of position error, which is tens of mph over a short window. Would need validation against ground truth before any number reached a user. |
| Known camera intrinsics | removes one unknown | Necessary for all of the above, not sufficient for any. |

## Decision

Not shipped, and not prototyped behind a disabled flag either. A flag implies
the code exists and was judged nearly ready; none of the approaches above has
been validated against ground truth in this project, so there is nothing whose
readiness could be claimed.

Instead, handheld mode is made genuinely useful without speed — stable identity,
class, detection confidence, tracking state, observed duration, frame-relative
motion, and operator-triggered plate reading — and the UI states plainly:

```
Handheld · speed unavailable
```

with `Mount and calibrate for speed` on the selected vehicle's speed row.

Frame-relative motion **is** shown, because it is honestly derivable from image
motion alone, and it is labelled as a direction (`Approaching`, `Receding`,
`Moving left`, `Moving right`, `Stationary in frame`) and never as a rate. It
carries no unit.

## What would change this

A validated pipeline, in this order:

1. WebXR 6-DoF pose available on the target device, or a metric depth model with
   measured error bounds.
2. Compensated speed measured against an independent ground truth — a second
   calibrated mounted RoadLens, or a vehicle's own GPS track — across at least
   the range of distances, speeds and lighting in
   `docs/PHYSICAL_VALIDATION.md`.
3. A published error distribution, not a single agreeing run.

Until all three exist, "mount and calibrate for speed" is the correct answer,
and it is the one the product gives.
