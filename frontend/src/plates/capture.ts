import { PLATE_LIMITS } from "../../../shared/src/limits";
import type { FrameResult, TrackView } from "../../../shared/src/schemas";
import {
  capturePlateCrop,
  PlateUnavailableError,
  type PlateCropSnapshot,
  type RemoteDetector,
} from "../inference/remote";
import { cropQuality, cropSharpness } from "./quality";
import { plateConsensus, type PlateObservation } from "./consensus";

/**
 * Event-driven, bounded plate capture.
 *
 * Nothing here runs per vehicle per frame. A track only enters the pipeline
 * when something qualifies it — the operator asked, or the rules made it a
 * speed candidate — and even then it contributes a small fixed number of crops.
 * Traffic analysis owns the GPU; plate work takes whatever is left and is
 * refused the moment it isn't.
 *
 * All state is RAM-only and keyed by capture epoch, so a new source, a seek or
 * End session discards every crop, reading and consensus with it.
 */
export type PlateCaptureMode = "off" | "candidates" | "all";
export type PlateTrackStatus =
  "idle" | "pending" | "read" | "unreadable" | "unavailable";
export interface PlateTrackState {
  status: PlateTrackStatus;
  plateText: string | null;
  plateConfidence: number | null;
  supportingFrames: number;
  detectorConfidence: number | null;
  submitted: number;
  /**
   * Where the plate detector last found a plate, in frame-normalised
   * coordinates. Display feedback for the selected vehicle only: it shows the
   * operator that the system is looking at the right rectangle.
   */
  plateBox: readonly [number, number, number, number] | null;
}
interface Candidate {
  quality: number;
  bbox: readonly [number, number, number, number];
  sourceId: string;
  sourceWidth: number;
  sourceHeight: number;
  sharpness: number;
  frameSeq: number;
  frameId: string;
  sourceTimeMs: number;
  submitted: boolean;
}
interface RescueCandidate extends Candidate {
  snapshot: PlateCropSnapshot | null;
  encoding: boolean;
  failures: number;
}
interface RescueRecord {
  captureEpoch: string;
  trackId: number;
  expiresAt: number;
  candidates: RescueCandidate[];
  timer: ReturnType<typeof setTimeout>;
}
interface TrackRecord {
  candidates: Candidate[];
  observations: PlateObservation[];
  submitted: number;
  inFlight: boolean;
  requested: boolean;
  /** Last successful localisation, already mapped into frame coordinates. */
  plateBox: readonly [number, number, number, number] | null;
  detectorConfidence: number | null;
  /** When this track entered the pipeline, for the analysis deadline. */
  startedAt: number;
}
const VEHICLES = new Set(["car", "motorcycle", "bus", "truck"]);
/** Vehicle boxes are tight; a plate sits at the very edge of one. */
const CROP_PADDING = 0.06;

export class PlateCapture {
  mode: PlateCaptureMode = "candidates";
  onChange = () => {};
  /** Injectable so the deadline is testable without waiting for it. */
  constructor(private readonly clock: () => number = () => performance.now()) {}
  /** Set when the leased worker has no plate pipeline at all. */
  private unavailable = false;
  private epoch: string | null = null;
  private tracks = new Map<number, TrackRecord>();
  private rescues = new Map<number, RescueRecord>();
  private rescueBytes = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private explicit = new Set<number>();
  /** When each explicit request was made, so the card always resolves. */
  private requestedAt = new Map<number, number>();
  private busy = false;
  private lastSubmittedAt = -Infinity;
  private submittedTotal = 0;
  private completedTotal = 0;
  private refusedTotal = 0;
  private latencies: number[] = [];
  private lastCrop = {
    vehicleWidth: 0,
    vehicleHeight: 0,
    sharpness: 0,
    quality: 0,
    plateWidth: 0,
    plateHeight: 0,
  };

  get diagnostics() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      mode: this.mode,
      available: !this.unavailable,
      tracks: this.tracks.size,
      submitted: this.submittedTotal,
      completed: this.completedTotal,
      refused: this.refusedTotal,
      inFlight: this.busy ? 1 : 0,
      medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0,
      maxMs: sorted.length ? sorted.at(-1)! : 0,
      rescueReports: this.rescues.size,
      rescueCrops: [...this.rescues.values()].reduce(
        (total, rescue) =>
          total + rescue.candidates.filter((item) => item.snapshot).length,
        0,
      ),
      rescueQueued: [...this.rescues.values()].reduce(
        (total, rescue) => total + rescue.candidates.length,
        0,
      ),
      rescueBytes: this.rescueBytes,
      lastCrop: { ...this.lastCrop },
    };
  }

  /** Discard every crop, reading and consensus. Called on epoch change and End session. */
  reset() {
    for (const rescue of this.rescues.values()) clearTimeout(rescue.timer);
    this.rescues.clear();
    this.rescueBytes = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.tracks.clear();
    this.explicit.clear();
    this.requestedAt.clear();
    this.epoch = null;
    this.busy = false;
    this.unavailable = false;
    this.lastSubmittedAt = -Infinity;
    this.submittedTotal = 0;
    this.completedTotal = 0;
    this.refusedTotal = 0;
    this.latencies = [];
    this.lastCrop = {
      vehicleWidth: 0,
      vehicleHeight: 0,
      sharpness: 0,
      quality: 0,
      plateWidth: 0,
      plateHeight: 0,
    };
    this.onChange();
  }

  /**
   * Explicitly ask for this vehicle, whatever the rules think. Availability is
   * supplied by the caller so a browser-only session resolves to an honest
   * "Plate unavailable" instead of waiting for a worker that does not exist.
   */
  request(trackId: number, available = true) {
    if (this.explicit.size >= PLATE_LIMITS.tracks) return false;
    this.explicit.add(trackId);
    if (!available) this.unavailable = true;
    // The moment of asking starts the clock, not the first successful
    // submission. Refusals hand the frame budget back so a better look can be
    // tried, which is right, but it must not leave the operator being told
    // nothing was analysed while the system is still trying.
    if (!this.requestedAt.has(trackId))
      this.requestedAt.set(trackId, this.clock());
    this.onChange();
    return true;
  }

  state(trackId: number): PlateTrackState {
    const record = this.tracks.get(trackId);
    if (this.unavailable)
      return {
        status: "unavailable",
        plateText: null,
        plateConfidence: null,
        supportingFrames: 0,
        detectorConfidence: null,
        submitted: record?.submitted ?? 0,
        plateBox: null,
      };
    if (!record || (!record.submitted && !record.inFlight)) {
      const asked = this.requestedAt.get(trackId);
      return {
        status:
          asked === undefined
            ? "idle"
            : this.clock() - asked >= PLATE_LIMITS.analysisDeadlineMs
              ? "unreadable"
              : "pending",
        plateText: null,
        plateConfidence: null,
        supportingFrames: 0,
        detectorConfidence: null,
        submitted: 0,
        plateBox: null,
      };
    }
    const consensus = plateConsensus(record.observations);
    // A track with budget left and work in flight is pending, not unreadable:
    // the UI must not flash a verdict it is about to change. But a vehicle can
    // turn away or simply never show a legible plate, so the deadline settles
    // what the frame budget alone would leave pending forever.
    const exhausted =
      !record.inFlight &&
      (record.submitted >= PLATE_LIMITS.framesPerTrack ||
        this.clock() - record.startedAt >= PLATE_LIMITS.analysisDeadlineMs);
    const status: PlateTrackStatus = consensus.plateText
      ? "read"
      : exhausted
        ? "unreadable"
        : "pending";
    return {
      status,
      plateText: consensus.plateText,
      plateConfidence: consensus.plateConfidence,
      supportingFrames: consensus.supportingFrames,
      detectorConfidence:
        consensus.detectorConfidence ?? record.detectorConfidence,
      submitted: record.submitted,
      plateBox: record.plateBox,
    };
  }

  private qualifies(track: TrackView) {
    if (!track.observed || !VEHICLES.has(track.className)) return false;
    if (this.explicit.has(track.trackId)) return true;
    if (this.mode === "off") return false;
    if (this.mode === "all") return true;
    return track.ruleState === "candidate";
  }

  /**
   * Free one slot by dropping a track that has spent its frame budget.
   *
   * Its consensus has already been written to any report following it, because
   * every change is flushed as it settles. Without this a long session would
   * simply stop looking at new vehicles after the first eight.
   */
  private evict() {
    for (const [trackId, record] of this.tracks)
      if (!record.inFlight && record.submitted >= PLATE_LIMITS.framesPerTrack) {
        this.tracks.delete(trackId);
        this.explicit.delete(trackId);
        this.requestedAt.delete(trackId);
        this.clearRescue(trackId);
        return true;
      }
    return false;
  }

  private padded(bbox: readonly [number, number, number, number]): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const padX = (bbox[2] - bbox[0]) * CROP_PADDING;
    const padY = (bbox[3] - bbox[1]) * CROP_PADDING;
    const x = Math.max(0, bbox[0] - padX);
    const y = Math.max(0, bbox[1] - padY);
    return {
      x,
      y,
      width: Math.min(1 - x, bbox[2] - bbox[0] + padX * 2),
      height: Math.min(1 - y, bbox[3] - bbox[1] + padY * 2),
    };
  }

  private clearRescue(trackId: number) {
    const rescue = this.rescues.get(trackId);
    if (!rescue) return;
    clearTimeout(rescue.timer);
    for (const candidate of rescue.candidates)
      if (candidate.snapshot) this.rescueBytes -= candidate.snapshot.blob.size;
    this.rescues.delete(trackId);
    this.rescueBytes = Math.max(0, this.rescueBytes);
  }

  private schedulePump(remote: RemoteDetector) {
    if (this.retryTimer || this.rescues.size === 0) return;
    const remaining = Math.max(
      0,
      PLATE_LIMITS.minIntervalMs - (this.clock() - this.lastSubmittedAt),
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.pump(remote);
    }, remaining);
  }

  private recordFor(trackId: number) {
    let record = this.tracks.get(trackId);
    if (!record) {
      if (this.tracks.size >= PLATE_LIMITS.tracks && !this.evict()) return null;
      record = {
        candidates: [],
        observations: [],
        submitted: 0,
        inFlight: false,
        requested: false,
        plateBox: null,
        detectorConfidence: null,
        startedAt: this.clock(),
      };
      this.tracks.set(trackId, record);
    }
    return record;
  }

  /**
   * Lock the exact report-time vehicle pixels before evidence annotation. The
   * returned promise is intentionally not awaited by the frame callback: the
   * crop copy is synchronous and JPEG encoding completes off the hot path.
   */
  beginReportRescue(
    frame: FrameResult,
    canvas: HTMLCanvasElement,
    remote: RemoteDetector | null | undefined,
    trackId: number,
  ) {
    if (!remote?.plateAvailable) return false;
    const track = frame.tracks.find(
      (candidate) =>
        candidate.observed &&
        candidate.trackId === trackId &&
        VEHICLES.has(candidate.className),
    );
    if (!track || (frame.captureEpoch !== this.epoch && this.epoch !== null))
      return false;
    this.epoch = frame.captureEpoch;
    const record = this.recordFor(trackId);
    if (!record) return false;
    this.explicit.add(trackId);
    this.requestedAt.set(
      trackId,
      this.requestedAt.get(trackId) ?? this.clock(),
    );
    if (!this.rescues.has(trackId)) {
      while (this.rescues.size >= PLATE_LIMITS.rescueReports) {
        const oldest = this.rescues.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        this.clearRescue(oldest);
      }
      const expiresAt = this.clock() + PLATE_LIMITS.rescueTtlMs;
      const timer = setTimeout(() => {
        this.clearRescue(trackId);
        this.onChange();
      }, PLATE_LIMITS.rescueTtlMs);
      this.rescues.set(trackId, {
        captureEpoch: frame.captureEpoch,
        trackId,
        expiresAt,
        candidates: [],
        timer,
      });
    }
    this.captureRescue(frame, canvas, remote, track);
    this.onChange();
    return true;
  }

  private captureRescue(
    frame: FrameResult,
    canvas: HTMLCanvasElement,
    remote: RemoteDetector,
    track: TrackView,
  ) {
    const rescue = this.rescues.get(track.trackId);
    if (
      !rescue ||
      rescue.captureEpoch !== frame.captureEpoch ||
      this.clock() > rescue.expiresAt ||
      rescue.candidates.some((candidate) => candidate.frameId === frame.frameId)
    )
      return;
    const sharpness = cropSharpness(canvas, track.bbox);
    const quality = cropQuality({
      bbox: track.bbox,
      sourceWidth: frame.frameWidth,
      sourceHeight: frame.frameHeight,
      detectionScore: track.score,
      sharpness,
    });
    if (quality <= 0) return;
    if (rescue.candidates.length >= PLATE_LIMITS.rescueFrames) {
      const weakest = [...rescue.candidates]
        .filter((entry) => !entry.submitted && !entry.encoding)
        .sort((a, b) => a.quality - b.quality)[0];
      if (!weakest || weakest.quality >= quality) return;
      rescue.candidates.splice(rescue.candidates.indexOf(weakest), 1);
      if (weakest.snapshot) this.rescueBytes -= weakest.snapshot.blob.size;
    }
    const candidate: RescueCandidate = {
      quality,
      bbox: track.bbox,
      sourceId: frame.sourceId,
      sourceWidth: frame.frameWidth,
      sourceHeight: frame.frameHeight,
      sharpness,
      frameSeq: frame.frameSeq,
      frameId: frame.frameId,
      sourceTimeMs: frame.sourceTimeMs,
      submitted: false,
      snapshot: null,
      encoding: true,
      failures: 0,
    };
    rescue.candidates.push(candidate);
    void capturePlateCrop(canvas, this.padded(track.bbox))
      .then((snapshot) => {
        const current = this.rescues.get(track.trackId);
        if (!current || !current.candidates.includes(candidate)) return;
        candidate.encoding = false;
        candidate.snapshot = snapshot;
        this.rescueBytes += snapshot.blob.size;
        current.candidates.sort((a, b) => b.quality - a.quality);
        while (
          current.candidates.length > PLATE_LIMITS.rescueFrames ||
          this.rescueBytes > PLATE_LIMITS.rescueBytes
        ) {
          const removable = [...current.candidates]
            .reverse()
            .find((entry) => !entry.submitted && !entry.encoding);
          if (!removable) break;
          const index = current.candidates.indexOf(removable);
          current.candidates.splice(index, 1);
          if (removable.snapshot)
            this.rescueBytes -= removable.snapshot.blob.size;
        }
        void this.pump(remote);
        this.onChange();
      })
      .catch(() => {
        const current = this.rescues.get(track.trackId);
        if (current)
          current.candidates = current.candidates.filter(
            (entry) => entry !== candidate,
          );
      });
  }

  /**
   * Consider one completed analysis frame. Crops are measured against the full
   * resolution canvas the detector ran on, which is the only surface that ever
   * held the plate's pixels.
   */
  observe(
    frame: FrameResult,
    canvas: HTMLCanvasElement,
    remote: RemoteDetector | null | undefined,
  ) {
    if (!remote) return;
    if (!remote.plateAvailable) {
      if (!this.unavailable) {
        this.unavailable = true;
        this.onChange();
      }
      return;
    }
    if (this.unavailable) {
      this.unavailable = false;
      this.onChange();
    }
    if (frame.captureEpoch !== this.epoch) {
      // A new epoch is a different measurement world, and track ids do not
      // survive it, so old crops, readings and selections cannot be attributed
      // to the tracks in this one. Adopting the *first* epoch is not a change:
      // a vehicle selected just before analysis starts must still be read.
      if (this.epoch !== null) {
        for (const trackId of this.rescues.keys()) this.clearRescue(trackId);
        this.tracks.clear();
        this.explicit.clear();
        this.requestedAt.clear();
        this.busy = false;
      }
      this.epoch = frame.captureEpoch;
    }
    for (const track of frame.tracks) {
      if (!this.qualifies(track)) continue;
      // Sharpness needs a pixel readback, which stalls the capture thread, so
      // reject a crop that is too small to hold a plate before paying for it.
      const longEdge = Math.max(
        (track.bbox[2] - track.bbox[0]) * frame.frameWidth,
        (track.bbox[3] - track.bbox[1]) * frame.frameHeight,
      );
      if (longEdge < PLATE_LIMITS.minCropEdge) continue;
      let record = this.tracks.get(track.trackId);
      if (!record) {
        if (this.tracks.size >= PLATE_LIMITS.tracks && !this.evict()) continue;
        const created = this.recordFor(track.trackId);
        if (!created) continue;
        record = created;
      }
      if (record.submitted >= PLATE_LIMITS.framesPerTrack) continue;
      if (this.rescues.has(track.trackId)) {
        this.captureRescue(frame, canvas, remote, track);
        continue;
      }
      const sharpness = cropSharpness(canvas, track.bbox);
      const quality = cropQuality({
        bbox: track.bbox,
        sourceWidth: frame.frameWidth,
        sourceHeight: frame.frameHeight,
        detectionScore: track.score,
        sharpness,
      });
      if (quality <= 0) continue;
      const current: Candidate = {
        quality,
        bbox: track.bbox,
        sourceId: frame.sourceId,
        sourceWidth: frame.frameWidth,
        sourceHeight: frame.frameHeight,
        sharpness,
        frameSeq: frame.frameSeq,
        frameId: frame.frameId,
        sourceTimeMs: frame.sourceTimeMs,
        submitted: false,
      };
      record.candidates.push(current);
      // Keep only the best few looks. Sorting by quality and truncating is what
      // makes the buffer bounded no matter how long a vehicle stays in view.
      record.candidates.sort((a, b) => b.quality - a.quality);
      record.candidates.length = Math.min(
        record.candidates.length,
        PLATE_LIMITS.framesPerTrack,
      );
      // Only a crop from this very frame can be taken from the canvas in hand,
      // so the current look must survive truncation even when older ones scored
      // marginally better. Without this, a steady scene - where every look
      // scores almost the same - fills the buffer with frames whose pixels are
      // gone and never submits again, leaving the operator on "Analyzing…"
      // permanently. Observed in production before this line existed.
      if (!record.candidates.includes(current)) {
        const worst = record.candidates.reduce(
          (low, entry, index) =>
            !entry.submitted && entry.quality < record.candidates[low]!.quality
              ? index
              : low,
          0,
        );
        if (!record.candidates[worst]!.submitted)
          record.candidates[worst] = current;
      }
    }
    void this.pump(remote, { frame, canvas });
  }

  /** Submit at most one crop, and only when nothing else is outstanding. */
  private async pump(
    remote: RemoteDetector,
    current?: { frame: FrameResult; canvas: HTMLCanvasElement },
  ) {
    if (this.busy || remote.plateInFlight >= PLATE_LIMITS.maxInFlight) return;
    if (this.clock() - this.lastSubmittedAt < PLATE_LIMITS.minIntervalMs)
      return;
    let chosen: {
      trackId: number;
      record: TrackRecord;
      candidate: Candidate | RescueCandidate;
      rescue: boolean;
    } | null = null;
    for (const [trackId, rescue] of this.rescues) {
      const record = this.tracks.get(trackId);
      if (
        !record ||
        record.inFlight ||
        record.submitted >= PLATE_LIMITS.framesPerTrack
      )
        continue;
      const candidate = rescue.candidates.find(
        (entry) => !entry.submitted && !!entry.snapshot,
      );
      if (
        candidate &&
        (!chosen || candidate.quality > chosen.candidate.quality)
      )
        chosen = { trackId, record, candidate, rescue: true };
    }
    for (const [trackId, record] of this.tracks) {
      if (chosen) break;
      if (record.inFlight || record.submitted >= PLATE_LIMITS.framesPerTrack)
        continue;
      // Only a crop from this very frame can be cropped from this canvas; older
      // candidates describe pixels that no longer exist anywhere.
      const candidate = record.candidates.find(
        (entry) =>
          !entry.submitted && entry.frameSeq === current?.frame.frameSeq,
      );
      if (!candidate) continue;
      chosen = { trackId, record, candidate, rescue: false };
    }
    if (!chosen) return;
    const { trackId, record, candidate } = chosen;
    this.busy = true;
    record.inFlight = true;
    candidate.submitted = true;
    record.submitted++;
    this.submittedTotal++;
    this.lastSubmittedAt = this.clock();
    const started = performance.now();
    const crop = chosen.rescue
      ? (candidate as RescueCandidate).snapshot!.crop
      : this.padded(candidate.bbox);
    const vehicleWidth = Math.round(crop.width * candidate.sourceWidth);
    const vehicleHeight = Math.round(crop.height * candidate.sourceHeight);
    const encodedScale = Math.min(
      1,
      PLATE_LIMITS.cropEdge / Math.max(vehicleWidth, vehicleHeight),
    );
    this.lastCrop = {
      vehicleWidth,
      vehicleHeight,
      sharpness: candidate.sharpness,
      quality: candidate.quality,
      plateWidth: 0,
      plateHeight: 0,
    };
    try {
      const rescueCandidate = chosen.rescue
        ? (chosen.candidate as RescueCandidate)
        : null;
      const identity = {
        sourceId: candidate.sourceId,
        captureEpoch: this.epoch!,
        frameSeq: candidate.frameSeq,
        frameId: candidate.frameId,
        trackId,
        sourceTimeMs: candidate.sourceTimeMs,
      };
      const result = rescueCandidate?.snapshot
        ? await remote.readPlateSnapshot(rescueCandidate.snapshot, identity)
        : await remote.readPlate(current!.canvas, {
            ...identity,
            crop: this.padded(candidate.bbox),
          });
      // Reject anything that belongs to a session, epoch or track this
      // controller has already moved past.
      if (
        result.captureEpoch !== this.epoch ||
        result.trackId !== trackId ||
        !this.tracks.has(trackId)
      )
        return;
      record.observations.push({
        text: result.plateText,
        confidence: result.plateConfidence,
        detectorConfidence: result.detectorConfidence,
        quality: candidate.quality,
        sourceFrame: `${result.captureEpoch}:${result.frameSeq}:${result.sourceTimeMs}`,
      });
      if (result.detectorConfidence !== null)
        record.detectorConfidence = Math.max(
          record.detectorConfidence ?? 0,
          result.detectorConfidence,
        );
      // The worker reports the plate box inside the crop it was sent. Mapping it
      // back through that crop is the only way it means anything to the overlay.
      if (result.plateBox) {
        const c =
          rescueCandidate?.snapshot?.crop ?? this.padded(candidate.bbox);
        record.plateBox = [
          c.x + result.plateBox[0] * c.width,
          c.y + result.plateBox[1] * c.height,
          c.x + result.plateBox[2] * c.width,
          c.y + result.plateBox[3] * c.height,
        ];
        const encodedWidth =
          rescueCandidate?.snapshot?.encodedWidth ??
          Math.round(vehicleWidth * encodedScale);
        const encodedHeight =
          rescueCandidate?.snapshot?.encodedHeight ??
          Math.round(vehicleHeight * encodedScale);
        this.lastCrop.plateWidth = Math.round(
          (result.plateBox[2] - result.plateBox[0]) * encodedWidth,
        );
        this.lastCrop.plateHeight = Math.round(
          (result.plateBox[3] - result.plateBox[1]) * encodedHeight,
        );
      }
      this.completedTotal++;
      this.latencies.push(performance.now() - started);
      this.latencies = this.latencies.slice(-40);
      this.onChange();
      if (plateConsensus(record.observations).plateText)
        this.clearRescue(trackId);
    } catch (error) {
      this.refusedTotal++;
      // A refusal costs this track nothing: give the frame budget back so a
      // later, possibly better look can still be tried.
      if (chosen.rescue) {
        const rescueCandidate = candidate as RescueCandidate;
        rescueCandidate.failures++;
        if (rescueCandidate.failures <= PLATE_LIMITS.rescueRetriesPerCrop) {
          record.submitted--;
          candidate.submitted = false;
          this.schedulePump(remote);
        }
      } else {
        record.submitted--;
        candidate.submitted = false;
      }
      if (
        error instanceof PlateUnavailableError &&
        error.message === "unavailable"
      ) {
        this.unavailable = true;
        this.onChange();
      }
    } finally {
      record.inFlight = false;
      this.busy = false;
      this.schedulePump(remote);
    }
  }
}
