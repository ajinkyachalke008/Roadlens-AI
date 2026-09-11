/**
 * Frame identity and frame time answer different questions, so they are derived
 * from different metadata.
 *
 * A live MediaStream is not file playback: Safari reports `mediaTime` 0 for
 * every getUserMedia frame, so media time can answer neither question there.
 * Live frames are identified by `presentedFrames` and timed by the
 * browser-local presentation clock, normalised to the capture epoch. Replay
 * frames keep media-timeline semantics so seeking, jumping and pausing stay
 * correct.
 *
 * Every accepted timestamp is browser-local frame presentation timing. Network,
 * relay and GPU completion timing never enter this clock: speed is measured
 * from source-time differences and must not move with latency.
 */

/** Beyond this the tracker's continuity is meaningless, so measurement restarts. */
export const CONTINUITY_GAP_MS = 2000;

export type FrameTimingSource =
  "presentationTime" | "expectedDisplayTime" | "callbackNow" | "mediaTime";

/** The subset of VideoFrameCallbackMetadata this clock reads. */
export interface FrameMetadata {
  mediaTime?: number;
  presentationTime?: number;
  expectedDisplayTime?: number;
  presentedFrames?: number;
}

export interface FrameSample {
  /** DOMHighResTimeStamp handed to the requestVideoFrameCallback callback. */
  now: number;
  metadata?: FrameMetadata | null;
  /** video.currentTime in seconds: the media timeline without frame metadata. */
  currentTime?: number;
}

export type FrameRejection =
  "duplicate_frame" | "duplicate_media_time" | "unusable_timing";

export interface FrameTick {
  accept: boolean;
  sourceTimeMs: number;
  frameIdentity: number;
  timingSource: FrameTimingSource;
  /** Timing continuity broke: the caller must restart its capture epoch. */
  discontinuity: boolean;
  reason: FrameRejection | null;
}

const usable = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export class FrameClock {
  /** Live frames are exposed relative to this browser-local presentation origin. */
  private origin = 0;
  private started = false;
  private lastRaw = -Infinity;
  private lastPresented: number | null = null;
  private locked: FrameTimingSource | null = null;
  private counter = 0;
  /** Last accepted values, for diagnostics only. */
  timingSource: FrameTimingSource | null = null;
  presentedFrames: number | null = null;
  sourceTimeMs = 0;
  frameIdentity = 0;

  reset() {
    this.origin = 0;
    this.started = false;
    this.lastRaw = -Infinity;
    this.lastPresented = null;
    this.locked = null;
    this.counter = 0;
    this.timingSource = null;
    this.presentedFrames = null;
    this.sourceTimeMs = 0;
    this.frameIdentity = 0;
  }

  /**
   * Current reading of this epoch's live presentation clock, in the same units
   * as the live sourceTimeMs it hands out. Display-side overlay age only: it is
   * never an observation and never reaches measurement.
   */
  liveElapsedMs(now: number): number | null {
    if (!this.started || this.locked === "mediaTime" || !Number.isFinite(now))
      return null;
    return Math.max(this.sourceTimeMs, now - this.origin);
  }

  nextFrame(mode: "live_camera" | "replay_video", sample: FrameSample) {
    return mode === "replay_video"
      ? this.nextReplayFrame(sample)
      : this.nextLiveFrame(sample);
  }

  nextLiveFrame(sample: FrameSample): FrameTick {
    const raw = sample.metadata?.presentedFrames;
    const presented =
      usable(raw) && Number.isInteger(raw) ? (raw as number) : null;
    // Frame identity, not timestamp equality, decides whether a frame is new.
    if (presented !== null && this.lastPresented !== null) {
      if (presented === this.lastPresented)
        return this.reject("duplicate_frame");
    }
    const restarted =
      presented !== null &&
      this.lastPresented !== null &&
      presented < this.lastPresented;
    const pick = this.pickLive(sample);
    if (!pick) return this.reject("unusable_timing");
    const discontinuity =
      !this.started ||
      restarted ||
      pick.source !== this.locked ||
      pick.raw < this.lastRaw ||
      pick.raw - this.lastRaw > CONTINUITY_GAP_MS;
    // A frame that is new but cannot be given a later timestamp is skipped
    // rather than timestamped identically: measurement needs strict advance.
    if (!discontinuity && pick.raw <= this.lastRaw)
      return this.reject("duplicate_frame");
    if (discontinuity) this.origin = pick.raw;
    this.started = true;
    this.locked = pick.source;
    this.lastRaw = pick.raw;
    this.lastPresented = presented;
    return this.accept(
      Math.max(0, pick.raw - this.origin),
      presented ?? ++this.counter,
      pick.source,
      discontinuity,
    );
  }

  nextReplayFrame(sample: FrameSample): FrameTick {
    const media = sample.metadata?.mediaTime;
    const raw = usable(media)
      ? media * 1000
      : usable(sample.currentTime)
        ? sample.currentTime * 1000
        : null;
    if (raw === null) return this.reject("unusable_timing");
    if (this.started && raw === this.lastRaw)
      return this.reject("duplicate_media_time");
    const discontinuity =
      !this.started ||
      raw < this.lastRaw ||
      raw - this.lastRaw > CONTINUITY_GAP_MS;
    this.started = true;
    this.lastRaw = raw;
    this.locked = "mediaTime";
    const presented = sample.metadata?.presentedFrames;
    this.lastPresented = usable(presented) ? presented : null;
    // Media position stays authoritative: replay is never normalised away.
    return this.accept(raw, raw, "mediaTime", discontinuity);
  }

  /**
   * Highest-priority browser-local timestamp that still advances. The source
   * stays locked for the epoch so two browser clocks are never interleaved.
   */
  private pickLive(sample: FrameSample) {
    const metadata = sample.metadata;
    const candidates: { source: FrameTimingSource; raw: number }[] = [];
    const add = (source: FrameTimingSource, value: unknown) => {
      if (usable(value)) candidates.push({ source, raw: value });
    };
    add("presentationTime", metadata?.presentationTime);
    add("expectedDisplayTime", metadata?.expectedDisplayTime);
    add("callbackNow", sample.now);
    if (!candidates.length) return null;
    const ordered = this.locked
      ? [
          ...candidates.filter((c) => c.source === this.locked),
          ...candidates.filter((c) => c.source !== this.locked),
        ]
      : candidates;
    return ordered.find((c) => c.raw > this.lastRaw) ?? ordered[0]!;
  }

  private accept(
    sourceTimeMs: number,
    frameIdentity: number,
    timingSource: FrameTimingSource,
    discontinuity: boolean,
  ): FrameTick {
    this.sourceTimeMs = sourceTimeMs;
    this.frameIdentity = frameIdentity;
    this.timingSource = timingSource;
    this.presentedFrames = this.lastPresented;
    return {
      accept: true,
      sourceTimeMs,
      frameIdentity,
      timingSource,
      discontinuity,
      reason: null,
    };
  }

  private reject(reason: FrameRejection): FrameTick {
    return {
      accept: false,
      sourceTimeMs: this.sourceTimeMs,
      frameIdentity: this.frameIdentity,
      timingSource: this.timingSource ?? "callbackNow",
      discontinuity: false,
      reason,
    };
  }
}
