import type { Box } from "../tracking/tracker";
export type BackgroundStatus =
  "verified" | "background_unverified" | "camera_moved";
interface Patch {
  x: number;
  y: number;
  values: number[];
  energy: number;
}
/** Conservative static-patch NCC guard. Input must be the same low-resolution grayscale geometry each time. */
export class BackgroundGuard {
  private patches: Patch[] = [];
  private width = 0;
  private height = 0;
  private moved = false;
  reset(): void {
    this.patches = [];
    this.moved = false;
    this.width = 0;
    this.height = 0;
  }
  private patch(
    gray: Uint8Array,
    width: number,
    x: number,
    y: number,
  ): { values: number[]; energy: number } {
    const raw: number[] = [];
    for (let dy = -5; dy <= 5; dy++)
      for (let dx = -5; dx <= 5; dx++)
        raw.push(gray[(y + dy) * width + x + dx]!);
    const mean = raw.reduce((s, x) => s + x, 0) / raw.length;
    const values = raw.map((x) => x - mean),
      energy = values.reduce((s, x) => s + x * x, 0);
    return { values, energy };
  }
  private occluded(
    x: number,
    y: number,
    width: number,
    height: number,
    exclusions: Box[],
  ): boolean {
    return exclusions.some(
      (b) =>
        x + 8 >= b[0] * width &&
        x - 8 <= b[2] * width &&
        y + 8 >= b[1] * height &&
        y - 8 <= b[3] * height,
    );
  }
  capture(
    gray: Uint8Array,
    width: number,
    height: number,
    exclusions: Box[] = [],
  ): BackgroundStatus {
    this.reset();
    if (
      gray.length !== width * height ||
      width < 48 ||
      height < 48 ||
      width > 640 ||
      height > 640
    )
      return "background_unverified";
    this.width = width;
    this.height = height;
    for (let gy = 1; gy <= 4; gy++)
      for (let gx = 1; gx <= 5; gx++) {
        const x = Math.round((gx * width) / 6),
          y = Math.round((gy * height) / 5);
        if (this.occluded(x, y, width, height, exclusions)) continue;
        const patch = this.patch(gray, width, x, y);
        if (patch.energy / patch.values.length >= 100)
          this.patches.push({ x, y, ...patch });
      }
    this.patches = this.patches.sort((a, b) => b.energy - a.energy).slice(0, 8);
    // A reference alone is not current verification. Require a subsequent comparison.
    return "background_unverified";
  }
  check(
    gray: Uint8Array,
    width: number,
    height: number,
    exclusions: Box[] = [],
  ): BackgroundStatus {
    if (width !== this.width || height !== this.height) {
      this.moved = true;
      return "camera_moved";
    }
    if (this.moved) return "camera_moved";
    if (gray.length !== width * height || this.patches.length < 3)
      return "background_unverified";
    let verified = 0,
      uncertain = 0;
    for (const reference of this.patches) {
      if (this.occluded(reference.x, reference.y, width, height, exclusions)) {
        uncertain++;
        continue;
      }
      const matches: { correlation: number; dx: number; dy: number }[] = [];
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const sample = this.patch(
            gray,
            width,
            reference.x + dx,
            reference.y + dy,
          );
          if (sample.energy / sample.values.length < 100) continue;
          const dot = reference.values.reduce(
            (s, x, i) => s + x * sample.values[i]!,
            0,
          );
          matches.push({
            correlation: dot / Math.sqrt(reference.energy * sample.energy),
            dx,
            dy,
          });
        }
      matches.sort((a, b) => b.correlation - a.correlation);
      const best = matches[0],
        runner = matches.find(
          (m) => best && Math.hypot(m.dx - best.dx, m.dy - best.dy) > 1,
        );
      if (
        !best ||
        best.correlation < 0.92 ||
        (runner && best.correlation - runner.correlation < 0.025)
      ) {
        uncertain++;
        continue;
      }
      if (Math.hypot(best.dx, best.dy) >= 1) {
        this.moved = true;
        return "camera_moved";
      }
      verified++;
    }
    return verified >= 3 && uncertain <= 1
      ? "verified"
      : "background_unverified";
  }
}
