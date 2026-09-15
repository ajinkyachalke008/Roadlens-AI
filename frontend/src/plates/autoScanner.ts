import type { TrackView } from "../../../shared/src/schemas";
import type { CompletedFrame } from "../camera/capture";
import { scanIndianPlateFromCanvas, type IndianPlateScanResult } from "./indianPlateScanner";

export type AutoScanTriggerMode = "all" | "speed_only";

export interface AutoScanDetectionEvent {
  track: TrackView;
  scanResult: IndianPlateScanResult;
  completed: CompletedFrame;
}

export class AutoPlateScanner {
  enabled = false;
  triggerMode: AutoScanTriggerMode = "all";
  private scannedTracks = new Set<number>();
  private attemptedTracks = new Map<number, number>();
  private isBusy = false;
  private lastScanTime = 0;
  minIntervalMs = 500; // Throttle to prevent overwhelming WASM worker
  private maxAttemptsPerTrack = 2;

  onPlateDetected?: (event: AutoScanDetectionEvent) => void;

  reset() {
    this.scannedTracks.clear();
    this.attemptedTracks.clear();
    this.isBusy = false;
    this.lastScanTime = 0;
  }

  get scannedCount(): number {
    return this.scannedTracks.size;
  }

  isTrackScanned(trackId: number): boolean {
    return this.scannedTracks.has(trackId);
  }

  async processFrame(completed: CompletedFrame): Promise<void> {
    if (!this.enabled || this.isBusy) return;

    const now = performance.now();
    if (now - this.lastScanTime < this.minIntervalMs) return;

    const canvas = completed.canvas;
    if (!canvas || canvas.width < 100 || canvas.height < 100) return;

    // Filter candidate tracks
    const candidates: TrackView[] = [];
    const speedLimit = completed.policy.speedLimitMps;

    for (const track of completed.result.tracks) {
      // 1. Only scan motorized vehicles
      const isVehicle = ["car", "truck", "bus", "motorcycle"].includes(
        track.className.toLowerCase(),
      );
      if (!isVehicle) continue;

      // 2. Skip if already recognized with an Indian plate
      if (this.scannedTracks.has(track.trackId)) continue;

      // 3. Skip if exceeded max attempts
      const attempts = this.attemptedTracks.get(track.trackId) ?? 0;
      if (attempts >= this.maxAttemptsPerTrack) continue;

      // 4. Check trigger mode
      if (this.triggerMode === "speed_only") {
        if (speedLimit === null || track.speedMps === null || track.speedMps <= speedLimit) {
          continue;
        }
      }

      // 5. Size check: vehicle must be sufficiently large in the frame (e.g. > 60x40px)
      // bbox is in [x0, y0, x1, y1] (normalized [0..1] or pixel coordinates)
      let bw = Math.abs(track.bbox[2] - track.bbox[0]);
      let bh = Math.abs(track.bbox[3] - track.bbox[1]);
      if (track.bbox[2] <= 1 && track.bbox[3] <= 1) {
        bw *= canvas.width;
        bh *= canvas.height;
      }

      // Don't scan vehicles that are far away (tiny in frame)
      if (bw < 60 || bh < 40) continue;

      candidates.push(track);
    }

    if (candidates.length === 0) return;

    // Pick the largest/closest vehicle first (greatest area)
    candidates.sort((a, b) => {
      const areaA =
        Math.abs(a.bbox[2] - a.bbox[0]) * Math.abs(a.bbox[3] - a.bbox[1]);
      const areaB =
        Math.abs(b.bbox[2] - b.bbox[0]) * Math.abs(b.bbox[3] - b.bbox[1]);
      return areaB - areaA;
    });

    const targetTrack = candidates[0];
    const currentAttempts = this.attemptedTracks.get(targetTrack.trackId) ?? 0;
    this.attemptedTracks.set(targetTrack.trackId, currentAttempts + 1);

    this.isBusy = true;
    this.lastScanTime = performance.now();

    try {
      const scanResult = await scanIndianPlateFromCanvas(canvas, targetTrack.bbox);

      if (scanResult.success && scanResult.plate?.isValid) {
        this.scannedTracks.add(targetTrack.trackId);
        this.onPlateDetected?.({
          track: targetTrack,
          scanResult,
          completed,
        });
      }
    } catch {
      // Ignore OCR errors in background auto-scan
    } finally {
      this.isBusy = false;
    }
  }
}
