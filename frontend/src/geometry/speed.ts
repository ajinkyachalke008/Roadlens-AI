import type { TrackedObject } from "../tracking/tracker";
import { LIMITS } from "../../../shared/src/limits";
import {
  insidePolygon,
  project,
  type Calibration,
  type Point,
} from "./calibration";
export interface SpeedContext {
  calibration: Calibration | null;
  captureEpoch: string;
  frameWidth: number;
  frameHeight: number;
  mounted: boolean;
  background: "verified" | "background_unverified" | "camera_moved";
  paused?: boolean;
}
export interface SpeedEstimate {
  speedMps: number | null;
  reason: string | null;
  residualM: number | null;
  coverageMs: number;
  sampleCount: number;
  trajectory: { sourceTimeMs: number; point: Point }[];
}
const median = (values: number[]) => {
  const a = [...values].sort((x, y) => x - y);
  return a.length % 2
    ? a[(a.length - 1) / 2]!
    : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2;
};
export const toMph = (mps: number) => mps * 2.2369362921;
export const toKmh = (mps: number) => mps * 3.6;
export function estimateSpeed(
  track: TrackedObject,
  context: SpeedContext,
): SpeedEstimate {
  const invalid = (reason: string): SpeedEstimate => ({
    speedMps: null,
    reason,
    residualM: null,
    coverageMs: 0,
    sampleCount: 0,
    trajectory: [],
  });
  if (context.paused) return invalid("paused");
  if (!context.mounted) return invalid("handheld");
  if (context.background === "camera_moved") return invalid("camera_moved");
  const c = context.calibration;
  if (!c) return invalid("not_calibrated");
  if (
    c.captureEpoch !== context.captureEpoch ||
    c.frameWidth !== context.frameWidth ||
    c.frameHeight !== context.frameHeight ||
    !c.stationaryConfirmed
  )
    return invalid("calibration_invalid");
  if (context.background !== "verified") return invalid(context.background);
  if (track.ambiguous || track.state !== "confirmed" || !track.observed)
    return invalid("track_ambiguous");
  const latest = track.observations.at(-1)?.sourceTimeMs ?? 0;
  const observations = track.observations
    .filter((o) => latest - o.sourceTimeMs <= 5000)
    .slice(-LIMITS.observations);
  const samples: { sourceTimeMs: number; point: Point }[] = [];
  for (const o of observations) {
    const image: Point = [(o.bbox[0] + o.bbox[2]) / 2, o.bbox[3]];
    if (!insidePolygon(image, c.zone)) {
      samples.length = 0;
      continue;
    }
    const point = project(c.H, image);
    if (!point) return invalid("calibration_invalid");
    samples.push({ sourceTimeMs: o.sourceTimeMs, point });
  }
  const currentPoint: Point = [
    (track.bbox[0] + track.bbox[2]) / 2,
    track.bbox[3],
  ];
  if (!insidePolygon(currentPoint, c.zone)) return invalid("outside_zone");
  if (samples.length < 8) return invalid("insufficient_samples");
  const duration = samples.at(-1)!.sourceTimeMs - samples[0]!.sourceTimeMs;
  const gaps = samples
    .slice(1)
    .map((s, i) => s.sourceTimeMs - samples[i]!.sourceTimeMs);
  if (gaps.some((g) => g <= 0)) return invalid("time_discontinuity");
  if (duration < 1500) return invalid("insufficient_samples");
  if (((samples.length - 1) * 1000) / duration < 4 || Math.max(...gaps) > 350)
    return invalid("sampling_too_sparse");
  const start = samples[0]!.point,
    end = samples.at(-1)!.point;
  const displacement = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (displacement < 3) return invalid("insufficient_displacement");
  const sx: number[] = [],
    sy: number[] = [];
  for (let i = 0; i < samples.length; i++)
    for (let j = i + 1; j < samples.length; j++) {
      const a = samples[i]!,
        b = samples[j]!,
        dt = (b.sourceTimeMs - a.sourceTimeMs) / 1000;
      if (dt < 0.25) continue;
      sx.push((b.point[0] - a.point[0]) / dt);
      sy.push((b.point[1] - a.point[1]) / dt);
    }
  const vx = median(sx),
    vy = median(sy),
    t0 = samples[0]!.sourceTimeMs;
  const x0 = median(
    samples.map((s) => s.point[0] - (vx * (s.sourceTimeMs - t0)) / 1000),
  );
  const y0 = median(
    samples.map((s) => s.point[1] - (vy * (s.sourceTimeMs - t0)) / 1000),
  );
  const residualM = Math.sqrt(
    samples.reduce((sum, s) => {
      const dt = (s.sourceTimeMs - t0) / 1000;
      return (
        sum +
        (s.point[0] - x0 - vx * dt) ** 2 +
        (s.point[1] - y0 - vy * dt) ** 2
      );
    }, 0) / samples.length,
  );
  if (
    !Number.isFinite(residualM) ||
    residualM > Math.max(0.5, displacement * 0.1)
  )
    return invalid("residual_too_high");
  const speedMps = Math.hypot(vx, vy);
  if (
    speedMps > 80 ||
    samples
      .slice(1)
      .some(
        (s, i) =>
          Math.hypot(
            s.point[0] - samples[i]!.point[0],
            s.point[1] - samples[i]!.point[1],
          ) /
            (gaps[i]! / 1000) >
          100,
      )
  )
    return invalid("implausible_motion");
  if (
    samples
      .slice(1)
      .some(
        (s, i) =>
          (s.point[0] - samples[i]!.point[0]) * vx +
            (s.point[1] - samples[i]!.point[1]) * vy <
          -0.25 * speedMps,
      )
  )
    return invalid("inconsistent_direction");
  return {
    speedMps,
    reason: null,
    residualM,
    coverageMs: duration,
    sampleCount: samples.length,
    trajectory: samples
      .filter(
        (_, i) =>
          i === samples.length - 1 || i % Math.ceil(samples.length / 7) === 0,
      )
      .slice(-8),
  };
}
