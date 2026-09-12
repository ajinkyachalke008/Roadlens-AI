import type { FrameResult, TrackView } from "../../../shared/src/schemas";

export const SHOWCASE_ARMING_MS = 5_000;
export const SHOWCASE_WAIT_MS = 25_000;
export const SHOWCASE_MIN_SCORE = 0.6;
export const SHOWCASE_MIN_OBSERVED_MS = 100;

const VEHICLES = new Set<TrackView["className"]>([
  "car",
  "motorcycle",
  "bus",
  "truck",
]);

export type ShowcasePhase =
  | "off"
  | "arming"
  | "waiting_for_vehicle"
  | "target_acquired"
  | "report_created"
  | "plate_pending"
  | "complete"
  | "timed_out"
  | "failed";

export interface ShowcaseState {
  enabled: boolean;
  phase: ShowcasePhase;
  captureEpoch: string | null;
  firstAnalyzedAtMs: number | null;
  armedAtMs: number | null;
  targetTrackId: number | null;
  reportId: string | null;
  reselections: number;
  error: string | null;
}

const initialState = (enabled = false): ShowcaseState => ({
  enabled,
  phase: enabled ? "arming" : "off",
  captureEpoch: null,
  firstAnalyzedAtMs: null,
  armedAtMs: null,
  targetTrackId: null,
  reportId: null,
  reselections: 0,
  error: null,
});

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * A deterministic presentation score based only on real track geometry and
 * detector/tracker facts. Plate text is deliberately absent from the inputs.
 */
export function showcaseScore(track: TrackView, frame: FrameResult) {
  const [x0, y0, x1, y1] = track.bbox;
  const width = x1 - x0;
  const height = y1 - y0;
  const area = width * height;
  const centerDistance = Math.hypot((x0 + x1) / 2 - 0.5, (y0 + y1) / 2 - 0.5);
  const edgeClearance = Math.min(x0, y0, 1 - x1, 1 - y1);
  const cropLongEdge = Math.max(
    width * frame.frameWidth,
    height * frame.frameHeight,
  );
  return (
    clamp01(area / 0.18) * 0.25 +
    clamp01(1 - centerDistance / Math.SQRT1_2) * 0.23 +
    clamp01(edgeClearance / 0.12) * 0.15 +
    clamp01((track.observedMs ?? 0) / 2_000) * 0.12 +
    track.score * 0.15 +
    clamp01(cropLongEdge / 400) * 0.1
  );
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
  const [x0, y0, x1, y1] = track.bbox;
  return (
    Math.max((x1 - x0) * frame.frameWidth, (y1 - y0) * frame.frameHeight) >= 64
  );
}

export function selectShowcaseTrack(
  frame: FrameResult,
  excludedTrackIds: ReadonlySet<number> = new Set(),
) {
  let best: { track: TrackView; score: number } | null = null;
  for (const track of frame.tracks) {
    if (
      excludedTrackIds.has(track.trackId) ||
      !eligibleShowcaseTrack(track, frame)
    )
      continue;
    const score = showcaseScore(track, frame);
    if (
      !best ||
      score > best.score ||
      (score === best.score && track.trackId < best.track.trackId)
    )
      best = { track, score };
  }
  return best?.track ?? null;
}

/** One RAM-only state machine for the complete Showcase lifecycle. */
export class ShowcaseController {
  private value = initialState();

  get phase() {
    return this.value.phase;
  }

  get acceptsFrames() {
    return (
      this.value.enabled &&
      (this.value.phase === "arming" ||
        this.value.phase === "waiting_for_vehicle")
    );
  }

  snapshot(): ShowcaseState {
    return { ...this.value };
  }

  setEnabled(enabled: boolean) {
    this.value = initialState(enabled);
    return this.snapshot();
  }

  /** A new capture epoch may re-arm an enabled run, but never carries a target. */
  resetContinuity() {
    this.value = initialState(this.value.enabled);
    return this.snapshot();
  }

  /**
   * Consume one completed real analysis frame. Returns a track exactly once,
   * after the source-time arming delay and only while the acquisition is open.
   */
  onFrame(
    frame: FrameResult,
    excludedTrackIds: ReadonlySet<number> = new Set(),
  ): TrackView | null {
    if (!this.value.enabled) return null;
    if (this.value.captureEpoch !== frame.captureEpoch) {
      this.value = {
        ...initialState(true),
        captureEpoch: frame.captureEpoch,
        firstAnalyzedAtMs: frame.sourceTimeMs,
      };
      return null;
    }
    const first = this.value.firstAnalyzedAtMs;
    if (first === null || frame.sourceTimeMs < first) {
      this.value = {
        ...initialState(true),
        captureEpoch: frame.captureEpoch,
        firstAnalyzedAtMs: frame.sourceTimeMs,
      };
      return null;
    }
    if (this.value.phase === "arming") {
      if (frame.sourceTimeMs - first < SHOWCASE_ARMING_MS) return null;
      this.value.phase = "waiting_for_vehicle";
      this.value.armedAtMs = frame.sourceTimeMs;
    }
    if (this.value.phase !== "waiting_for_vehicle") return null;
    if (
      this.value.armedAtMs !== null &&
      frame.sourceTimeMs - this.value.armedAtMs > SHOWCASE_WAIT_MS
    ) {
      this.value.phase = "timed_out";
      return null;
    }
    const target = selectShowcaseTrack(frame, excludedTrackIds);
    if (!target) return null;
    this.value.phase = "target_acquired";
    this.value.targetTrackId = target.trackId;
    return target;
  }

  markReportCreated(reportId: string, plateStatus: string) {
    if (this.value.phase !== "target_acquired") return this.snapshot();
    this.value.reportId = reportId;
    this.value.phase =
      plateStatus === "pending"
        ? "plate_pending"
        : plateStatus === "read" ||
            plateStatus === "unreadable" ||
            plateStatus === "unavailable"
          ? "complete"
          : "report_created";
    return this.snapshot();
  }

  updatePlate(plateStatus: string) {
    if (!this.value.reportId) return this.snapshot();
    if (plateStatus === "pending") this.value.phase = "plate_pending";
    if (
      plateStatus === "read" ||
      plateStatus === "unreadable" ||
      plateStatus === "unavailable"
    )
      this.value.phase = "complete";
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
    case "waiting_for_vehicle":
      return "Waiting for vehicle…";
    case "target_acquired":
      return "Locked";
    case "report_created":
      return "Report created";
    case "plate_pending":
      return "Plate pending";
    case "complete":
      return "Complete";
    case "timed_out":
      return "No vehicle";
    case "failed":
      return "Failed";
    default:
      return "Off";
  }
}
