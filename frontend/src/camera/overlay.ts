import type { FrameResult, TrackView } from "../../../shared/src/schemas";

/**
 * Display-only overlay geometry and motion.
 *
 * Everything in this module exists to make the *picture* legible between
 * analysed frames. None of it is measurement: interpolated boxes never reach
 * the tracker, the homography, the speed estimator, candidate rules, counts or
 * evidence. Those consume the authoritative FrameResult only.
 */
export const OVERLAY_LIMITS = Object.freeze({
  /** Display-only forward horizon. Beyond this the last observation is held. */
  extrapolationMs: 120,
  /**
   * Reported health bands. Measured on the real path: a local GPU holds the
   * overlay near 120 ms, and every 60 ms of relay round trip adds roughly the
   * same again, so 250 ms separates "keeping up" from "behind".
   */
  staleMs: 250,
  /**
   * Freezing is decided against the measured analysis cadence instead: at
   * 5 Hz the newest result is legitimately ~350 ms old, and fading a correct
   * box because the link is slow is worse than holding it.
   */
  staleFactor: 1.6,
  maxStaleMs: 700,
  /** Fully faded this long after going stale. */
  fadeMs: 900,
  /** Velocity is estimated across at most this many observations. */
  historyFrames: 3,
  /** History older than this cannot describe current motion. */
  historySpanMs: 500,
});

export interface ContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The rectangle an `object-fit: contain` source actually occupies inside its
 * box. Detector coordinates are normalized to the source, so boxes must be
 * mapped through this rectangle or they drift into the letterbox bars.
 */
export function contentRect(
  containerWidth: number,
  containerHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): ContentRect {
  const box = { x: 0, y: 0, width: containerWidth, height: containerHeight };
  if (
    ![containerWidth, containerHeight, sourceWidth, sourceHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return box;
  const scale = Math.min(
    containerWidth / sourceWidth,
    containerHeight / sourceHeight,
  );
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (containerWidth - width) / 2,
    y: (containerHeight - height) / 2,
    width,
    height,
  };
}

/** Normalized source coordinates to CSS pixels inside the content rectangle. */
export function toContent(
  bbox: readonly [number, number, number, number],
  rect: ContentRect,
) {
  return {
    x: rect.x + bbox[0] * rect.width,
    y: rect.y + bbox[1] * rect.height,
    width: (bbox[2] - bbox[0]) * rect.width,
    height: (bbox[3] - bbox[1]) * rect.height,
  };
}

export interface OverlayBox {
  trackId: number;
  className: TrackView["className"];
  /** Display-only position. Never an input to measurement. */
  bbox: [number, number, number, number];
  speedMps: number | null;
  ruleState: TrackView["ruleState"];
  /** How far the box was advanced past its last real observation. */
  extrapolatedMs: number;
  opacity: number;
}

export interface OverlayState {
  boxes: OverlayBox[];
  /** Age of the newest analysed result against the live presentation clock. */
  ageMs: number;
  /** Age at which this session freezes and fades, from measured cadence. */
  holdMs: number;
  health: "healthy" | "degraded" | "stale";
  frameId: string | null;
  sourceTimeMs: number;
}

const empty: OverlayState = {
  boxes: [],
  ageMs: 0,
  holdMs: OVERLAY_LIMITS.staleMs,
  health: "healthy",
  frameId: null,
  sourceTimeMs: 0,
};

interface Observation {
  sourceTimeMs: number;
  bbox: [number, number, number, number];
}

export function overlayHealth(ageMs: number): OverlayState["health"] {
  if (!Number.isFinite(ageMs) || ageMs < OVERLAY_LIMITS.staleMs / 2.5)
    return "healthy";
  return ageMs <= OVERLAY_LIMITS.staleMs ? "degraded" : "stale";
}

/**
 * Holds the newest analysed result plus a very short per-track history, and
 * answers "where should this box be drawn right now" for the render loop.
 */
export class OverlayModel {
  private latest: FrameResult | null = null;
  private epoch: string | null = null;
  private history = new Map<number, Observation[]>();
  private cadence: number[] = [];

  reset() {
    this.latest = null;
    this.epoch = null;
    this.history.clear();
    this.cadence = [];
  }

  /**
   * How long a result may be held before it is frozen and faded, measured from
   * the analysis cadence this session is actually achieving.
   */
  get holdMs() {
    if (this.cadence.length < 3) return OVERLAY_LIMITS.staleMs;
    const sorted = [...this.cadence].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1]!;
    return Math.min(
      OVERLAY_LIMITS.maxStaleMs,
      Math.max(OVERLAY_LIMITS.staleMs, median * OVERLAY_LIMITS.staleFactor),
    );
  }

  get result() {
    return this.latest;
  }

  /** Feed one completed, authoritative analysed frame. */
  update(result: FrameResult) {
    if (result.captureEpoch !== this.epoch) {
      this.history.clear();
      this.epoch = result.captureEpoch;
    } else if (this.latest && result.sourceTimeMs <= this.latest.sourceTimeMs) {
      // Out-of-order or repeated analysis never rewrites the display history.
      return;
    }
    if (this.latest && result.captureEpoch === this.latest.captureEpoch) {
      this.cadence.push(result.sourceTimeMs - this.latest.sourceTimeMs);
      this.cadence = this.cadence.slice(-9);
    } else this.cadence = [];
    this.latest = result;
    const live = new Set<number>();
    for (const track of result.tracks) {
      if (!track.observed) continue;
      live.add(track.trackId);
      const observations = this.history.get(track.trackId) ?? [];
      observations.push({
        sourceTimeMs: result.sourceTimeMs,
        bbox: [...track.bbox] as [number, number, number, number],
      });
      this.history.set(
        track.trackId,
        observations.slice(-OVERLAY_LIMITS.historyFrames),
      );
    }
    for (const id of [...this.history.keys()])
      if (!live.has(id)) this.history.delete(id);
  }

  /**
   * Display positions at the current live presentation time. Motion comes from
   * real observations; it is only ever advanced by a bounded horizon, and a
   * stale result is held in place and faded rather than predicted onwards.
   */
  stateAt(sourceNowMs: number): OverlayState {
    const latest = this.latest;
    if (!latest) return empty;
    const ageMs = Number.isFinite(sourceNowMs)
      ? Math.max(0, sourceNowMs - latest.sourceTimeMs)
      : 0;
    const hold = this.holdMs;
    const stale = ageMs > hold;
    const opacity = stale
      ? Math.max(0, 1 - (ageMs - hold) / OVERLAY_LIMITS.fadeMs)
      : 1;
    const advance = stale ? 0 : Math.min(ageMs, OVERLAY_LIMITS.extrapolationMs);
    const boxes: OverlayBox[] = [];
    for (const track of latest.tracks) {
      if (!track.observed) continue;
      const velocity = this.velocity(track.trackId);
      const bbox = track.bbox.map(
        (value, index) => value + velocity[index]! * advance,
      ) as [number, number, number, number];
      boxes.push({
        trackId: track.trackId,
        className: track.className,
        bbox: velocity.some((v) => v !== 0) ? bbox : [...track.bbox],
        speedMps: track.speedMps,
        ruleState: track.ruleState,
        extrapolatedMs: velocity.some((v) => v !== 0) ? advance : 0,
        opacity,
      });
    }
    return {
      boxes,
      ageMs,
      holdMs: hold,
      health: overlayHealth(ageMs),
      frameId: latest.frameId,
      sourceTimeMs: latest.sourceTimeMs,
    };
  }

  /** Normalized units per millisecond, measured across retained observations. */
  private velocity(trackId: number) {
    const zero = [0, 0, 0, 0];
    const observations = this.history.get(trackId);
    if (!observations || observations.length < 2) return zero;
    const first = observations[0]!;
    const last = observations.at(-1)!;
    const span = last.sourceTimeMs - first.sourceTimeMs;
    if (!(span > 0) || span > OVERLAY_LIMITS.historySpanMs) return zero;
    return last.bbox.map((value, index) => (value - first.bbox[index]!) / span);
  }
}
