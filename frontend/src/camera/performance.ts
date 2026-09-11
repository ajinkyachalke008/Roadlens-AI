/** Conservative scheduling policy driven only by completed same-clock jobs.
 * Profile changes start a new measurement epoch. There is no automatic upshift.
 */
export class AdaptivePerformance {
  profile: 416 | 320;
  intervalMs = 190;
  private samples: number[] = [];
  constructor(profile: 416 | 320) {
    this.profile = profile;
  }
  observe(processingMs: number) {
    if (!Number.isFinite(processingMs) || processingMs <= 0) return false;
    this.samples.push(processingMs);
    if (this.samples.length < 8) return false;
    const sorted = this.samples.sort((a, b) => a - b);
    const median = (sorted[3]! + sorted[4]!) / 2;
    this.samples = [];
    if (this.profile === 416 && median > 300) {
      this.profile = 320;
      this.intervalMs = 190;
      return true;
    }
    // Leave idle time for controls, rendering and thermals on slower devices.
    if (median > 250)
      this.intervalMs = Math.max(
        this.intervalMs,
        Math.min(2000, Math.ceil((median * 1.25) / 25) * 25),
      );
    return false;
  }
}
