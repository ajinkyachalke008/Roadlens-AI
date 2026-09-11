import type { ClassName, TrackedObject } from "../tracking/tracker";
import type { Point } from "../geometry/calibration";
export interface DirectedLine {
  a: Point;
  b: Point;
  hysteresis?: number;
}
export function countObserved(
  tracks: TrackedObject[],
): Record<ClassName, number> {
  const counts = {
    person: 0,
    bicycle: 0,
    car: 0,
    motorcycle: 0,
    bus: 0,
    truck: 0,
  };
  for (const t of tracks) if (t.observed) counts[t.className]++;
  return counts;
}
export class DirectedCounter {
  private epoch = "";
  private lineKey = "";
  private states = new Map<
    number,
    { side: number; point: Point; counted: boolean }
  >();
  private forward = 0;
  private reverse = 0;
  reset(): void {
    this.states.clear();
    this.forward = 0;
    this.reverse = 0;
    this.epoch = "";
    this.lineKey = "";
  }
  update(
    tracks: TrackedObject[],
    captureEpoch: string,
    line: DirectedLine,
  ): { forward: number; reverse: number } {
    const lineKey = JSON.stringify(line);
    if (captureEpoch !== this.epoch || lineKey !== this.lineKey) {
      this.reset();
      this.epoch = captureEpoch;
      this.lineKey = lineKey;
    }
    const dx = line.b[0] - line.a[0],
      dy = line.b[1] - line.a[1],
      length = Math.hypot(dx, dy);
    if (length < 1e-6 || !Number.isFinite(length))
      return { forward: this.forward, reverse: this.reverse };
    const present = new Set(tracks.map((t) => t.trackId));
    for (const [id, state] of this.states)
      if (!present.has(id) && !state.counted) this.states.delete(id);
    for (const t of tracks) {
      if (!t.observed || t.ambiguous || t.state !== "confirmed") {
        const old = this.states.get(t.trackId);
        if (old && !old.counted) this.states.delete(t.trackId);
        continue;
      }
      const p: Point = [(t.bbox[0] + t.bbox[2]) / 2, t.bbox[3]];
      const signed =
        (dx * (p[1] - line.a[1]) - dy * (p[0] - line.a[0])) / length;
      if (Math.abs(signed) < Math.max(0.005, line.hysteresis ?? 0.015))
        continue;
      const side = Math.sign(signed),
        old = this.states.get(t.trackId);
      if (old && !old.counted && old.side !== side) {
        // The trajectory must cross the finite segment, not its infinite extension.
        const oldSigned =
          (dx * (old.point[1] - line.a[1]) - dy * (old.point[0] - line.a[0])) /
          length;
        const ratio = oldSigned / (oldSigned - signed);
        const intersection: Point = [
          old.point[0] + ratio * (p[0] - old.point[0]),
          old.point[1] + ratio * (p[1] - old.point[1]),
        ];
        const along =
          ((intersection[0] - line.a[0]) * dx +
            (intersection[1] - line.a[1]) * dy) /
          (length * length);
        if (along >= 0 && along <= 1) {
          if (old.side < side) this.forward++;
          else this.reverse++;
          old.counted = true;
        }
      }
      // Keep the ledger bounded and never evict a counted ID within this epoch.
      if (old || this.states.size < 1000)
        this.states.set(t.trackId, {
          side,
          point: p,
          counted: old?.counted ?? false,
        });
    }
    return { forward: this.forward, reverse: this.reverse };
  }
}
