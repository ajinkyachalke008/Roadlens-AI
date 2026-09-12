import type { FrameResult, TrackView } from "../../../shared/src/schemas";

/** Source-time gates: replay speed and network latency cannot move these clocks. */
export const SHOWCASE_ARMING_MS = 4_000;
export const SHOWCASE_WAIT_MS = 25_000;
export const SHOWCASE_SELECTION_MS = 800;
export const SHOWCASE_TARGET_WAIT_MS = 6_500;
export const SHOWCASE_TARGET_LOST_MS = 800;
export const SHOWCASE_MIN_SCORE = 0.6;
export const SHOWCASE_MIN_OBSERVED_MS = 100;
export const SHOWCASE_LOCK_THRESHOLD = 0.46;
export const SHOWCASE_READY_THRESHOLD = 0.68;
export const SHOWCASE_FALLBACK_THRESHOLD = 0.56;

const VEHICLES = new Set<TrackView["className"]>([
  "car",
  "motorcycle",
  "bus",
  "truck",
]);

export type ShowcasePhase =
  | "off"
  | "arming"
  | "searching"
  | "acquiring"
  | "target_ready"
  | "report_created"
  | "plate_collecting"
  | "plate_confirmed"
  | "plate_unreadable"
  | "timed_out"
  | "failed";
export type ShowcaseTriggerReason =
  | "capture_quality"
  | "plate_localized"
  | "shrinking_opportunity"
  | "target_wait_expired"
  | "search_wait_expired";
export type GrowthTrend = "growing" | "stable" | "shrinking" | "unknown";

export interface ShowcaseQuality {
  /** Relative mean-Laplacian score from the real source crop. */
  sharpness: number;
  /** Existing source-pixel vehicle-crop quality score. */
  quality: number;
}

export interface ShowcaseState {
  enabled: boolean;
  phase: ShowcasePhase;
  captureEpoch: string | null;
  firstAnalyzedAtMs: number | null;
  armedAtMs: number | null;
  targetTrackId: number | null;
  targetLockedAtMs: number | null;
  targetBestReadiness: number;
  currentReadiness: number;
  growth: GrowthTrend;
  triggerReason: ShowcaseTriggerReason | null;
  reportId: string | null;
  reselections: number;
  error: string | null;
}

interface QualitySample {
  sourceTimeMs: number;
  longEdgePx: number;
  readiness: number;
}
interface CandidateHistory {
  firstSeenMs: number;
  lastSeenMs: number;
  bestReadiness: number;
  samples: QualitySample[];
}

const initialState = (enabled = false): ShowcaseState => ({
  enabled,
  phase: enabled ? "arming" : "off",
  captureEpoch: null,
  firstAnalyzedAtMs: null,
  armedAtMs: null,
  targetTrackId: null,
  targetLockedAtMs: null,
  targetBestReadiness: 0,
  currentReadiness: 0,
  growth: "unknown",
  triggerReason: null,
  reportId: null,
  reselections: 0,
  error: null,
});

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
export const showcaseLongEdge = (track: TrackView, frame: FrameResult) =>
  Math.max(
    (track.bbox[2] - track.bbox[0]) * frame.frameWidth,
    (track.bbox[3] - track.bbox[1]) * frame.frameHeight,
  );

/** Robust median source-pixel growth; this is image scale, never distance. */
export function showcaseGrowth(
  samples: readonly Pick<QualitySample, "sourceTimeMs" | "longEdgePx">[],
): GrowthTrend {
  if (samples.length < 3) return "unknown";
  const slopes: number[] = [];
  for (let index = 1; index < samples.length; index++) {
    const elapsed =
      samples[index]!.sourceTimeMs - samples[index - 1]!.sourceTimeMs;
    if (elapsed <= 0) continue;
    slopes.push(
      ((samples[index]!.longEdgePx - samples[index - 1]!.longEdgePx) * 1000) /
        elapsed,
    );
  }
  if (slopes.length < 2) return "unknown";
  slopes.sort((a, b) => a - b);
  const median = slopes[Math.floor(slopes.length / 2)]!;
  if (median >= 18) return "growing";
  if (median <= -18) return "shrinking";
  return "stable";
}

/**
 * Capture readiness is separate from detector confidence. Its dominant inputs
 * are source pixels and focus; track/framing facts prevent a large clipped or
 * unstable box from winning. Plate text is deliberately not an input.
 */
export function showcaseReadiness(
  track: TrackView,
  frame: FrameResult,
  measured?: ShowcaseQuality,
  growth: GrowthTrend = "unknown",
) {
  const [x0, y0, x1, y1] = track.bbox;
  const centerDistance = Math.hypot((x0 + x1) / 2 - 0.5, (y0 + y1) / 2 - 0.5);
  const edgeClearance = Math.min(x0, y0, 1 - x1, 1 - y1);
  const longEdge = showcaseLongEdge(track, frame);
  // Preserve ranking well into 1080p-class crops; saturating at ~420 px made a
  // merely medium vehicle indistinguishable from a substantially larger one.
  const size = clamp01((longEdge - 80) / 560);
  const focus = measured ? clamp01(measured.sharpness / 12) : 0.5;
  const centrality = clamp01(1 - centerDistance / Math.SQRT1_2);
  const framing = edgeClearance <= 0 ? 0.25 : clamp01(0.55 + edgeClearance * 5);
  const stability = clamp01((track.observedMs ?? 0) / 1_600);
  const growthValue =
    growth === "growing"
      ? 1
      : growth === "stable"
        ? 0.55
        : growth === "shrinking"
          ? 0.2
          : 0.4;
  const crop = measured?.quality ?? size * 0.65 + focus * 0.35;
  return clamp01(
    size * 0.22 +
      focus * 0.18 +
      crop * 0.16 +
      centrality * 0.1 +
      framing * 0.11 +
      stability * 0.12 +
      clamp01(track.score) * 0.07 +
      growthValue * 0.04,
  );
}

/** Compatibility helper used by deterministic selection tests and tooling. */
export function showcaseScore(
  track: TrackView,
  frame: FrameResult,
  measured?: ShowcaseQuality,
) {
  return showcaseReadiness(track, frame, measured);
}

export function eligibleShowcaseTrack(track: TrackView, frame: FrameResult) {
  if (
    !track.observed ||
    !VEHICLES.has(track.className) ||
    track.trackState !== "confirmed" ||
    track.score < SHOWCASE_MIN_SCORE ||
    (track.observedMs ?? 0) < SHOWCASE_MIN_OBSERVED_MS
  )
    return false;
  return showcaseLongEdge(track, frame) >= 64;
}

export function selectShowcaseTrack(
  frame: FrameResult,
  excludedTrackIds: ReadonlySet<number> = new Set(),
  qualities: ReadonlyMap<number, ShowcaseQuality> = new Map(),
) {
  let best: { track: TrackView; score: number } | null = null;
  for (const track of frame.tracks) {
    if (
      excludedTrackIds.has(track.trackId) ||
      !eligibleShowcaseTrack(track, frame)
    )
      continue;
    const score = showcaseScore(track, frame, qualities.get(track.trackId));
    if (
      !best ||
      score > best.score ||
      (score === best.score && track.trackId < best.track.trackId)
    )
      best = { track, score };
  }
  return best?.track ?? null;
}

/** One RAM-only, source-time state machine for the complete Showcase lifecycle. */
export class ShowcaseController {
  private value = initialState();
  private histories = new Map<number, CandidateHistory>();

  get phase() {
    return this.value.phase;
  }

  get acceptsFrames() {
    return (
      this.value.enabled &&
      (this.value.phase === "arming" ||
        this.value.phase === "searching" ||
        this.value.phase === "acquiring")
    );
  }

  snapshot(): ShowcaseState {
    return { ...this.value };
  }

  setEnabled(enabled: boolean) {
    this.histories.clear();
    this.value = initialState(enabled);
    return this.snapshot();
  }

  /** A new capture epoch may re-arm an enabled run, but never carries a target. */
  resetContinuity() {
    this.histories.clear();
    this.value = initialState(this.value.enabled);
    return this.snapshot();
  }

  private history(
    track: TrackView,
    frame: FrameResult,
    quality?: ShowcaseQuality,
  ) {
    let record = this.histories.get(track.trackId);
    if (!record) {
      record = {
        firstSeenMs: frame.sourceTimeMs,
        lastSeenMs: frame.sourceTimeMs,
        bestReadiness: 0,
        samples: [],
      };
      this.histories.set(track.trackId, record);
    }
    const provisional = showcaseReadiness(track, frame, quality);
    record.samples.push({
      sourceTimeMs: frame.sourceTimeMs,
      longEdgePx: showcaseLongEdge(track, frame),
      readiness: provisional,
    });
    record.samples = record.samples.slice(-6);
    const growth = showcaseGrowth(record.samples);
    const readiness = showcaseReadiness(track, frame, quality, growth);
    record.samples[record.samples.length - 1]!.readiness = readiness;
    record.lastSeenMs = frame.sourceTimeMs;
    record.bestReadiness = Math.max(record.bestReadiness, readiness);
    return { record, growth, readiness };
  }

  private ready(track: TrackView, reason: ShowcaseTriggerReason) {
    this.value.phase = "target_ready";
    this.value.triggerReason = reason;
    return track;
  }

  /**
   * Returns a track only when the immutable event frame should be created.
   * Locking happens earlier and is visible through snapshot().targetTrackId.
   */
  onFrame(
    frame: FrameResult,
    excludedTrackIds: ReadonlySet<number> = new Set(),
    qualities: ReadonlyMap<number, ShowcaseQuality> = new Map(),
    plateReadyTrackIds: ReadonlySet<number> = new Set(),
  ): TrackView | null {
    if (!this.value.enabled) return null;
    if (this.value.captureEpoch !== frame.captureEpoch) {
      this.histories.clear();
      this.value = {
        ...initialState(true),
        captureEpoch: frame.captureEpoch,
        firstAnalyzedAtMs: frame.sourceTimeMs,
      };
      return null;
    }
    const first = this.value.firstAnalyzedAtMs;
    if (first === null || frame.sourceTimeMs < first) {
      this.histories.clear();
      this.value = {
        ...initialState(true),
        captureEpoch: frame.captureEpoch,
        firstAnalyzedAtMs: frame.sourceTimeMs,
      };
      return null;
    }
    if (this.value.phase === "arming") {
      if (frame.sourceTimeMs - first < SHOWCASE_ARMING_MS) return null;
      this.value.phase = "searching";
      this.value.armedAtMs = frame.sourceTimeMs;
    }

    if (this.value.phase === "searching") {
      const eligible = frame.tracks.filter(
        (track) =>
          !excludedTrackIds.has(track.trackId) &&
          eligibleShowcaseTrack(track, frame),
      );
      let best: {
        track: TrackView;
        readiness: number;
        growth: GrowthTrend;
        record: CandidateHistory;
      } | null = null;
      for (const track of eligible) {
        const measured = this.history(
          track,
          frame,
          qualities.get(track.trackId),
        );
        if (
          !best ||
          measured.readiness > best.readiness ||
          (measured.readiness === best.readiness &&
            track.trackId < best.track.trackId)
        )
          best = { track, ...measured };
      }
      const waitExpired =
        this.value.armedAtMs !== null &&
        frame.sourceTimeMs - this.value.armedAtMs >= SHOWCASE_WAIT_MS;
      if (!best) {
        if (waitExpired) this.value.phase = "timed_out";
        return null;
      }
      const dwell = frame.sourceTimeMs - best.record.firstSeenMs;
      if (best.readiness < SHOWCASE_LOCK_THRESHOLD && !waitExpired) return null;
      if (
        best.readiness < SHOWCASE_READY_THRESHOLD &&
        dwell < SHOWCASE_SELECTION_MS &&
        !waitExpired
      )
        return null;
      this.value.phase = "acquiring";
      this.value.targetTrackId = best.track.trackId;
      this.value.targetLockedAtMs = frame.sourceTimeMs;
      this.value.currentReadiness = best.readiness;
      this.value.targetBestReadiness = best.record.bestReadiness;
      this.value.growth = best.growth;
      if (waitExpired) return this.ready(best.track, "search_wait_expired");
      if (best.readiness >= SHOWCASE_READY_THRESHOLD)
        return this.ready(best.track, "capture_quality");
      return null;
    }

    if (this.value.phase !== "acquiring" || this.value.targetTrackId === null)
      return null;
    const target = frame.tracks.find(
      (track) =>
        track.trackId === this.value.targetTrackId &&
        !excludedTrackIds.has(track.trackId) &&
        eligibleShowcaseTrack(track, frame),
    );
    if (!target) {
      const history = this.histories.get(this.value.targetTrackId);
      if (
        history &&
        frame.sourceTimeMs - history.lastSeenMs >= SHOWCASE_TARGET_LOST_MS
      ) {
        this.histories.delete(this.value.targetTrackId);
        this.value.phase = "searching";
        this.value.targetTrackId = null;
        this.value.targetLockedAtMs = null;
        this.value.targetBestReadiness = 0;
        this.value.currentReadiness = 0;
        this.value.growth = "unknown";
        this.value.reselections++;
      }
      return null;
    }
    const measured = this.history(target, frame, qualities.get(target.trackId));
    this.value.currentReadiness = measured.readiness;
    this.value.targetBestReadiness = measured.record.bestReadiness;
    this.value.growth = measured.growth;
    if (plateReadyTrackIds.has(target.trackId))
      return this.ready(target, "plate_localized");
    if (measured.readiness >= SHOWCASE_READY_THRESHOLD)
      return this.ready(target, "capture_quality");
    const acquiredMs =
      frame.sourceTimeMs - (this.value.targetLockedAtMs ?? frame.sourceTimeMs);
    if (
      acquiredMs >= SHOWCASE_SELECTION_MS &&
      measured.growth === "shrinking" &&
      measured.record.bestReadiness >= SHOWCASE_FALLBACK_THRESHOLD
    )
      return this.ready(target, "shrinking_opportunity");
    if (acquiredMs >= SHOWCASE_TARGET_WAIT_MS)
      return this.ready(target, "target_wait_expired");
    return null;
  }

  markReportCreated(reportId: string, plateStatus: string) {
    if (this.value.phase !== "target_ready") return this.snapshot();
    this.value.reportId = reportId;
    this.value.phase =
      plateStatus === "pending"
        ? "plate_collecting"
        : plateStatus === "read"
          ? "plate_confirmed"
          : "plate_unreadable";
    return this.snapshot();
  }

  updatePlate(plateStatus: string) {
    if (!this.value.reportId) return this.snapshot();
    if (plateStatus === "pending") this.value.phase = "plate_collecting";
    if (plateStatus === "read") this.value.phase = "plate_confirmed";
    if (plateStatus === "unreadable" || plateStatus === "unavailable")
      this.value.phase = "plate_unreadable";
    return this.snapshot();
  }

  fail(message: string) {
    this.value.phase = "failed";
    this.value.error = message;
    return this.snapshot();
  }
}

export function showcaseStatusLabel(state: ShowcaseState) {
  switch (state.phase) {
    case "arming":
      return "Arming";
    case "searching":
      return "Looking for clear vehicle…";
    case "acquiring":
      return "Acquiring clear view…";
    case "target_ready":
      return "Target ready";
    case "report_created":
      return "Report created";
    case "plate_collecting":
      return "Analyzing clearer frames…";
    case "plate_confirmed":
      return "Plate confirmed";
    case "plate_unreadable":
      return "Capture complete";
    case "timed_out":
      return "No vehicle";
    case "failed":
      return "Failed";
    default:
      return "Off";
  }
}
