import { LIMITS } from "../../../shared/src/limits";
export const TRACKER_VERSION = "time_aware_iou_v1";
export type Box = [number, number, number, number];
export type ClassName =
  "person" | "bicycle" | "car" | "motorcycle" | "bus" | "truck";
export interface Detection {
  className: ClassName;
  score: number;
  bbox: Box;
}
export interface Observation {
  sourceTimeMs: number;
  bbox: Box;
}
export interface TrackedObject extends Detection {
  trackId: number;
  observed: boolean;
  state: "tentative" | "confirmed" | "lost";
  ambiguous: boolean;
  observations: Observation[];
}
interface InternalTrack extends TrackedObject {
  lastSeen: number;
  hits: number;
  velocity: Box;
}
const center = (b: Box) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
export function iou(a: Box, b: Box): number {
  const overlap =
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return (
    overlap /
    Math.max(
      1e-12,
      (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - overlap,
    )
  );
}
/** Minimum-cost assignment, rectangular matrix. Dummy columns allow unmatched rows. */
export function hungarian(costs: number[][], unmatchedCost = 0.9): number[] {
  const n = costs.length;
  if (!n) return [];
  const realColumns = costs[0]!.length,
    m = realColumns + n;
  const u = Array<number>(n + 1).fill(0),
    v = Array<number>(m + 1).fill(0);
  const p = Array<number>(m + 1).fill(0),
    way = Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = Array<number>(m + 1).fill(Infinity),
      used = Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity,
        j1 = 0;
      for (let j = 1; j <= m; j++)
        if (!used[j]) {
          const c = j <= realColumns ? costs[i0 - 1]![j - 1]! : unmatchedCost;
          const cur = c - u[i0]! - v[j]!;
          if (cur < minv[j]!) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j]! < delta) {
            delta = minv[j]!;
            j1 = j;
          }
        }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else minv[j]! -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const result = Array<number>(n).fill(-1);
  for (let j = 1; j <= realColumns; j++)
    if (p[j] && costs[p[j]! - 1]![j - 1]! < unmatchedCost)
      result[p[j]! - 1] = j - 1;
  return result;
}
export class TimeAwareTracker {
  private tracks: InternalTrack[] = [];
  private epoch = "";
  private previousTime = -Infinity;
  private nextId = 1;
  reset(): void {
    this.tracks = [];
    this.epoch = "";
    this.previousTime = -Infinity;
    this.nextId = 1;
  }
  /** Recalibration/uncertain background breaks measurement continuity without recycling identities. */
  invalidateMeasurements(): void {
    for (const track of this.tracks) {
      track.observations = [];
      track.velocity = [0, 0, 0, 0];
      track.hits = 0;
      track.state = "tentative";
    }
  }
  update(
    input: Detection[],
    sourceTimeMs: number,
    captureEpoch: string,
    measurementEligible = true,
  ): TrackedObject[] {
    if (!Number.isFinite(sourceTimeMs) || sourceTimeMs < 0)
      throw new Error("time_discontinuity");
    if (captureEpoch !== this.epoch) {
      this.reset();
      this.epoch = captureEpoch;
    }
    if (sourceTimeMs <= this.previousTime) {
      this.tracks = [];
      this.previousTime = sourceTimeMs;
      return [];
    }
    this.previousTime = sourceTimeMs;
    // An uncertain current frame must not become the first point of a later
    // qualified window. Association still runs so detection-only IDs survive.
    if (!measurementEligible)
      for (const track of this.tracks) track.observations = [];
    const detections = input
      .filter(
        (d) =>
          d.score >= 0.1 &&
          d.score <= 1 &&
          d.bbox.every((x) => Number.isFinite(x) && x >= 0 && x <= 1) &&
          d.bbox[2] > d.bbox[0] &&
          d.bbox[3] > d.bbox[1],
      )
      .slice(0, LIMITS.tracks);
    this.tracks = this.tracks.filter((t) => sourceTimeMs - t.lastSeen <= 1500);
    for (const t of this.tracks) t.observed = false;
    const matched = new Set<number>();
    const associate = (tracks: InternalTrack[], indices: number[]) => {
      const costs = tracks.map((t) =>
        indices.map((index) => {
          const d = detections[index]!,
            dt = (sourceTimeMs - t.lastSeen) / 1000;
          const predicted = t.bbox.map(
            (x, i) => x + t.velocity[i]! * dt,
          ) as Box;
          const a = center(predicted),
            b = center(d.bbox),
            previous = center(t.bbox),
            overlap = iou(predicted, d.bbox);
          if (
            Math.hypot(previous[0]! - b[0]!, previous[1]! - b[1]!) >
            Math.max(0.1, dt * 1.5)
          )
            return 1e6;
          if (
            t.className !== d.className ||
            overlap < 0.15 ||
            Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!) > 0.25
          )
            return 1e6;
          return 1 - overlap;
        }),
      );
      hungarian(costs).forEach((col, row) => {
        if (col < 0) return;
        const t = tracks[row]!,
          index = indices[col]!,
          d = detections[index]!;
        const competingDetection = costs[row]!.some(
          (c, j) =>
            j !== col && c < 1e5 && Math.abs(c - costs[row]![col]!) < 0.08,
        );
        const competingTrack = costs.some(
          (r, j) =>
            j !== row &&
            r[col]! < 1e5 &&
            Math.abs(r[col]! - costs[row]![col]!) < 0.08,
        );
        const classConflict = detections.some(
          (other) =>
            other.className !== d.className && iou(other.bbox, d.bbox) > 0.7,
        );
        const dtMs = sourceTimeMs - t.lastSeen;
        t.ambiguous = competingDetection || competingTrack || classConflict;
        if (dtMs > 350 || t.state === "lost" || t.ambiguous)
          t.observations = [];
        t.velocity = d.bbox.map(
          (x, i) => (x - t.bbox[i]!) / (dtMs / 1000),
        ) as Box;
        t.bbox = [...d.bbox];
        t.score = d.score;
        t.lastSeen = sourceTimeMs;
        t.observed = true;
        t.hits++;
        t.state = t.hits >= 3 ? "confirmed" : "tentative";
        if (!t.ambiguous && measurementEligible)
          t.observations.push({ sourceTimeMs, bbox: [...d.bbox] });
        t.observations = t.observations.slice(-LIMITS.observations);
        matched.add(index);
      });
    };
    associate(
      this.tracks,
      detections.flatMap((d, i) => (d.score >= 0.5 ? [i] : [])),
    );
    associate(
      this.tracks.filter((t) => !t.observed && t.hits >= 3),
      detections.flatMap((d, i) =>
        d.score < 0.5 && !matched.has(i) ? [i] : [],
      ),
    );
    for (const t of this.tracks)
      if (!t.observed) {
        t.state = "lost";
        t.observations = [];
      }
    for (let i = 0; i < detections.length; i++) {
      const d = detections[i]!;
      if (matched.has(i) || d.score < 0.6) continue;
      if (this.tracks.length >= LIMITS.tracks) {
        // Current observations take priority over an older unmatched identity.
        // Releasing a lost track makes capacity; nextId is never rewound.
        let oldestLost = -1;
        for (let index = 0; index < this.tracks.length; index++) {
          const candidate = this.tracks[index]!;
          if (
            !candidate.observed &&
            (oldestLost < 0 ||
              candidate.lastSeen < this.tracks[oldestLost]!.lastSeen)
          )
            oldestLost = index;
        }
        if (oldestLost < 0) continue;
        this.tracks.splice(oldestLost, 1);
      }
      this.tracks.push({
        ...d,
        bbox: [...d.bbox],
        trackId: this.nextId++,
        observed: true,
        state: "tentative",
        ambiguous: false,
        observations: measurementEligible
          ? [{ sourceTimeMs, bbox: [...d.bbox] }]
          : [],
        lastSeen: sourceTimeMs,
        hits: 1,
        velocity: [0, 0, 0, 0],
      });
    }
    return this.tracks.map(
      ({ lastSeen: _lastSeen, hits: _hits, velocity: _velocity, ...t }) => ({
        ...t,
        bbox: [...t.bbox],
        observations: t.observations.map((o) => ({ ...o, bbox: [...o.bbox] })),
      }),
    );
  }
}
