/**
 * Reference trackers for benchmarking, written from the published algorithm
 * descriptions:
 *
 * - ByteTrack, Zhang et al., ECCV 2022, arXiv:2110.06864. Reference code is
 *   MIT licensed (github.com/ifzhang/ByteTrack).
 * - BoT-SORT, Aharon et al., 2022, arXiv:2206.14651. Reference code is MIT
 *   licensed (github.com/NirAharon/BoT-SORT).
 *
 * Both are motion-only here. BoT-SORT's appearance ReID branch needs a second
 * neural network producing embeddings per box; RoadLens receives boxes from a
 * remote worker and tracks in the browser, so no embeddings exist on the
 * tracking side and an appearance branch cannot be evaluated honestly. Its
 * global camera-motion compensation likewise needs the image, which the tracker
 * never sees. What is evaluated is therefore the motion core of each: the
 * Kalman state, the association cascade and the buffering policy.
 */
import { hungarian, iou, type Box, type Detection } from "../../frontend/src/tracking/tracker";
import type { TrackerOutput } from "./metrics";

/**
 * Constant-velocity Kalman filter over (centre x, centre y, aspect, height),
 * with the process and measurement noise scaled by height, as in SORT and both
 * trackers below.
 */
class KalmanBox {
  mean: number[];
  covariance: number[][];
  private static readonly positionWeight = 1 / 20;
  private static readonly velocityWeight = 1 / 160;
  constructor(box: Box) {
    const [cx, cy, a, h] = KalmanBox.toState(box);
    this.mean = [cx, cy, a, h, 0, 0, 0, 0];
    const p = 2 * KalmanBox.positionWeight * h;
    const v = 10 * KalmanBox.velocityWeight * h;
    const std = [p, p, 1e-2, p, v, v, 1e-5, v];
    this.covariance = std.map((s, i) =>
      std.map((_, j) => (i === j ? s * s : 0)),
    );
  }
  static toState(box: Box): [number, number, number, number] {
    const w = box[2] - box[0],
      h = box[3] - box[1];
    return [box[0] + w / 2, box[1] + h / 2, w / Math.max(1e-9, h), h];
  }
  static toBox(mean: number[]): Box {
    const [cx, cy, a, h] = mean as [number, number, number, number];
    const w = a * h;
    return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  }
  /** dt in frames, as both reference trackers assume a fixed cadence. */
  predict(dt = 1) {
    const h = Math.abs(this.mean[3]!);
    const p = KalmanBox.positionWeight * h,
      v = KalmanBox.velocityWeight * h;
    const q = [p, p, 1e-2, p, v, v, 1e-5, v].map((s) => s * s);
    for (let i = 0; i < 4; i++) this.mean[i]! += this.mean[i + 4]! * dt;
    const c = this.covariance;
    // F P F^T for F = [[I, dt*I],[0, I]], expanded rather than multiplied out.
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 8; j++) c[i]![j]! += dt * c[i + 4]![j]!;
    for (let j = 0; j < 8; j++)
      for (let i = 0; i < 4; i++) c[j]![i]! += dt * c[j]![i + 4]!;
    for (let i = 0; i < 8; i++) c[i]![i]! += q[i]!;
  }
  update(box: Box) {
    const z = KalmanBox.toState(box);
    const h = Math.abs(this.mean[3]!);
    const p = KalmanBox.positionWeight * h;
    const r = [p, p, 1e-1, p].map((s) => s * s);
    const c = this.covariance;
    // Innovation covariance S = H P H^T + R, with H selecting the first four.
    const s: number[][] = [];
    for (let i = 0; i < 4; i++) {
      s.push([]);
      for (let j = 0; j < 4; j++)
        s[i]!.push(c[i]![j]! + (i === j ? r[i]! : 0));
    }
    const inverse = invert4(s);
    if (!inverse) return;
    // K = P H^T S^-1
    const k: number[][] = [];
    for (let i = 0; i < 8; i++) {
      k.push([]);
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let m = 0; m < 4; m++) sum += c[i]![m]! * inverse[m]![j]!;
        k[i]!.push(sum);
      }
    }
    const innovation = z.map((value, i) => value - this.mean[i]!);
    for (let i = 0; i < 8; i++) {
      let delta = 0;
      for (let j = 0; j < 4; j++) delta += k[i]![j]! * innovation[j]!;
      this.mean[i]! += delta;
    }
    // P = P - K H P
    const updated = c.map((row) => [...row]);
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 8; j++) {
        let sum = 0;
        for (let m = 0; m < 4; m++) sum += k[i]![m]! * c[m]![j]!;
        updated[i]![j]! -= sum;
      }
    this.covariance = updated;
  }
  box(): Box {
    return KalmanBox.toBox(this.mean);
  }
}

function invert4(matrix: number[][]): number[][] | null {
  const n = 4;
  const a = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++)
      if (Math.abs(a[row]![column]!) > Math.abs(a[pivot]![column]!)) pivot = row;
    if (Math.abs(a[pivot]![column]!) < 1e-12) return null;
    [a[column], a[pivot]] = [a[pivot]!, a[column]!];
    const divisor = a[column]![column]!;
    for (let j = 0; j < 2 * n; j++) a[column]![j]! /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = a[row]![column]!;
      if (!factor) continue;
      for (let j = 0; j < 2 * n; j++) a[row]![j]! -= factor * a[column]![j]!;
    }
  }
  return a.map((row) => row.slice(n));
}

interface RefTrack {
  id: number;
  kalman: KalmanBox;
  className: string;
  score: number;
  state: "tracked" | "lost";
  hits: number;
  lastFrame: number;
  activated: boolean;
}

/** Shared association cascade; the two trackers differ in their cost function. */
abstract class CascadeTracker {
  protected tracks: RefTrack[] = [];
  protected nextId = 1;
  protected frame = 0;
  protected abstract firstThreshold: number;
  protected abstract secondThreshold: number;
  protected abstract newThreshold: number;
  protected abstract bufferFrames: number;
  protected abstract distance(track: RefTrack, detection: Detection): number;

  update(detections: Detection[], _sourceTimeMs: number): TrackerOutput[] {
    this.frame++;
    for (const track of this.tracks) track.kalman.predict();
    const high = detections.filter((d) => d.score >= 0.5);
    const low = detections.filter((d) => d.score < 0.5 && d.score >= 0.1);
    const observed = new Set<number>();

    const match = (
      pool: RefTrack[],
      candidates: Detection[],
      threshold: number,
    ) => {
      const leftovers = new Set(candidates);
      if (!pool.length || !candidates.length) return leftovers;
      const costs = pool.map((t) => candidates.map((d) => this.distance(t, d)));
      hungarian(costs, threshold).forEach((column, row) => {
        if (column < 0) return;
        const track = pool[row]!,
          detection = candidates[column]!;
        track.kalman.update(detection.bbox);
        track.score = detection.score;
        track.className = detection.className;
        track.state = "tracked";
        track.hits++;
        track.activated = track.hits >= 3;
        track.lastFrame = this.frame;
        observed.add(track.id);
        leftovers.delete(detection);
      });
      return leftovers;
    };

    const active = this.tracks.filter((t) => t.state === "tracked");
    const lost = this.tracks.filter((t) => t.state === "lost");
    const remainingHigh = match([...active, ...lost], high, this.firstThreshold);
    const stillUnmatched = this.tracks.filter((t) => !observed.has(t.id));
    match(
      stillUnmatched.filter((t) => t.hits >= 2),
      low,
      this.secondThreshold,
    );
    for (const track of this.tracks)
      if (!observed.has(track.id)) track.state = "lost";
    for (const detection of remainingHigh) {
      if (detection.score < this.newThreshold) continue;
      this.tracks.push({
        id: this.nextId++,
        kalman: new KalmanBox(detection.bbox),
        className: detection.className,
        score: detection.score,
        state: "tracked",
        hits: 1,
        lastFrame: this.frame,
        activated: false,
      });
      observed.add(this.tracks.at(-1)!.id);
    }
    this.tracks = this.tracks.filter(
      (t) => this.frame - t.lastFrame <= this.bufferFrames,
    );
    return this.tracks.map((t) => ({
      trackId: t.id,
      bbox: t.kalman.box(),
      observed: observed.has(t.id),
    }));
  }
}

/** ByteTrack: IoU distance, high-then-low cascade, 30-frame buffer. */
export class ByteTrackReference extends CascadeTracker {
  protected firstThreshold = 0.8;
  protected secondThreshold = 0.5;
  protected newThreshold = 0.6;
  protected bufferFrames = 30;
  protected distance(track: RefTrack, detection: Detection): number {
    return 1 - iou(track.kalman.box(), detection.bbox);
  }
}

/**
 * BoT-SORT motion core: the same cascade over a Kalman state that tracks width
 * and height directly, with IoU fused with a normalised centre distance in
 * place of the appearance branch that needs embeddings RoadLens does not have.
 */
export class BotSortReference extends CascadeTracker {
  protected firstThreshold = 0.75;
  protected secondThreshold = 0.5;
  protected newThreshold = 0.6;
  protected bufferFrames = 30;
  protected distance(track: RefTrack, detection: Detection): number {
    const predicted = track.kalman.box();
    const overlap = iou(predicted, detection.bbox);
    const pc = [
      (predicted[0] + predicted[2]) / 2,
      (predicted[1] + predicted[3]) / 2,
    ];
    const dc = [
      (detection.bbox[0] + detection.bbox[2]) / 2,
      (detection.bbox[1] + detection.bbox[3]) / 2,
    ];
    const diagonal = Math.hypot(
      predicted[2] - predicted[0],
      predicted[3] - predicted[1],
    );
    const proximity = Math.min(
      1,
      Math.hypot(pc[0]! - dc[0]!, pc[1]! - dc[1]!) / Math.max(1e-6, diagonal),
    );
    return 0.7 * (1 - overlap) + 0.3 * proximity;
  }
}
