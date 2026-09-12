import { LIMITS } from "../../../shared/src/limits";
import type { DiagnosticSink, RejectionReason } from "./diagnostics";
import {
  hungarian,
  iou,
  type Box,
  type ClassName,
  type Detection,
  type Observation,
  type TrackedObject,
} from "./tracker";

export const TRACKER_V2_VERSION = "time_aware_iou_v2";

/**
 * Association tuning. Every value is stated once, here, so the evaluation set
 * in tests/tracking measures the same numbers the product ships.
 */
export const V2 = Object.freeze({
  /** Cost weights. They sum to 1 before the class penalty is added. */
  iouWeight: 0.55,
  centerWeight: 0.3,
  scaleWeight: 0.15,
  /**
   * Cost above which an assignment is refused outright.
   *
   * Chosen from the middle of a wide plateau: every combination of maxCost in
   * [0.68, 0.80] and gateDiagonals in [0.6, 1.2] scores identically over the 23
   * evaluation scenarios. One cell (0.62 / 0.90) scored marginally better still
   * and was rejected, because all four of its neighbours are worse - a sharp
   * optimum on synthetic motion is tuning noise, not a better tracker.
   */
  maxCost: 0.72,
  /** Same group, different label: a penalty rather than a severed identity. */
  classPenalty: 0.12,
  /** Centre gate as a multiple of the track's own box diagonal. */
  gateDiagonals: 0.9,
  /** Absolute floor so a tiny distant box still has somewhere to move. */
  gateFloor: 0.02,
  /**
   * Allowance for prediction error as a fraction of the track's own diagonal:
   * detector jitter plus whatever constant velocity failed to capture.
   */
  gateResidual: 0.3,
  /** Predicted travel is added to the gate, with this much slack. */
  gateTravelSlack: 1.6,
  /** Ceiling on the gate: without it, a fast track would match anything. */
  gateCeiling: 0.42,
  /** Prediction is never extrapolated further than this. */
  maxPredictionMs: 600,
  /** Normalised units per second. Faster than this is not a road vehicle. */
  maxVelocity: 2.5,
  /** Velocity smoothing: the weight given to the newest measurement. */
  velocityGain: 0.45,
  /** Detections at or above this score drive the first association pass. */
  highScore: 0.5,
  /** A new identity needs at least this score. */
  newTrackScore: 0.6,
  /** Observations before a track is confirmed. */
  confirmHits: 3,
  /** A lost track stays reactivatable this long. */
  reactivationMs: 1200,
  /** Absolute expiry. */
  expiryMs: 1500,
  /** Cost margin within which two candidates are called ambiguous. */
  ambiguityMargin: 0.08,
  /** Measurement continuity breaks across a gap longer than this. */
  measurementGapMs: 350,
});

/** The tuning surface, widened from the literal types the frozen object infers. */
export type TrackerTuning = { readonly [K in keyof typeof V2]: number };

/**
 * Classes a detector genuinely confuses with each other. An SUV alternating
 * between `car` and `truck` is one vehicle, and severing its identity for that
 * was the single largest source of fragmentation in time_aware_iou_v1 - see
 * docs/TRACKING_EVALUATION.md. Groups stay narrow: `person` is never merged
 * with a two-wheeler, because counts depend on that distinction.
 */
const GROUP: Record<ClassName, string> = {
  car: "vehicle",
  truck: "vehicle",
  bus: "vehicle",
  motorcycle: "two_wheeler",
  bicycle: "two_wheeler",
  person: "person",
};

export type MotionState =
  | "approaching"
  | "receding"
  | "left"
  | "right"
  | "stationary"
  | "unknown";

export interface TrackedObjectV2 extends TrackedObject {
  /** Smoothed box velocity in normalised units per second. Display/relative use only. */
  velocity: Box;
  /** Source time of this track's first observation in the current epoch. */
  firstSeenMs: number;
  lastSeenMs: number;
  /** Successful associations so far. */
  hits: number;
  /**
   * Frame-relative motion. Honest about what it is: it mixes vehicle motion and
   * camera motion, so it is never a road speed and is never labelled as one.
   */
  motion: MotionState;
}

interface InternalTrack extends TrackedObjectV2 {
  /** Decayed, score-weighted class votes. Keeps the label stable under wobble. */
  votes: Map<ClassName, number>;
}

const center = (b: Box): [number, number] => [
  (b[0] + b[2]) / 2,
  (b[1] + b[3]) / 2,
];
const width = (b: Box) => b[2] - b[0];
const height = (b: Box) => b[3] - b[1];
const area = (b: Box) => Math.max(1e-9, width(b) * height(b));
const diagonal = (b: Box) => Math.hypot(width(b), height(b));

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

interface Candidate {
  cost: number;
  rejection: RejectionReason | null;
  iou: number;
  centerDistance: number;
  relative: number;
  predicted: Box;
}

/**
 * RoadLens tracker, second generation.
 *
 * Differences from time_aware_iou_v1, each one motivated by a measured failure
 * in the evaluation set rather than by a single clip:
 *
 * - class is a decayed vote, and a mismatch inside a confusable group costs a
 *   little instead of ending the track (the dominant v1 failure);
 * - the gate is scale- and motion-aware, in units of the track's own box, so a
 *   small distant vehicle and a fast near one are held to comparable standards;
 * - cost combines overlap, centre distance and scale, so association survives
 *   the zero-overlap frames that low analysis cadence produces;
 * - velocity is smoothed and bounded, so one noisy step cannot throw the
 *   prediction far enough to break the next association;
 * - low-confidence detections recover existing tracks without being allowed to
 *   create new ones, which is what a confidence dip needs;
 * - a lost track stays reactivatable for a bounded window.
 *
 * Measurement semantics are unchanged: observations are still cleared by gaps,
 * ambiguity and ineligible frames, so the speed engine sees the same contract.
 */
export class TimeAwareTrackerV2 {
  private tracks: InternalTrack[] = [];
  private epoch = "";
  private previousTime = -Infinity;
  private nextId = 1;
  diagnostics: DiagnosticSink | null = null;

  /**
   * Tuning is injected so the sweep in tests/tracking can explore settings
   * without mutating the shipped constants. Production always uses `V2`.
   */
  constructor(private readonly tuning: TrackerTuning = V2) {}

  reset(): void {
    this.tracks = [];
    this.epoch = "";
    this.previousTime = -Infinity;
    this.nextId = 1;
  }

  /** Recalibration or an uncertain background breaks measurement, not identity. */
  invalidateMeasurements(): void {
    for (const track of this.tracks) {
      track.observations = [];
      track.hits = 0;
      track.state = "tentative";
    }
  }

  private view(): TrackedObjectV2[] {
    return this.tracks.map((t) => ({
      trackId: t.trackId,
      className: t.className,
      score: t.score,
      bbox: [...t.bbox] as Box,
      observed: t.observed,
      state: t.state,
      ambiguous: t.ambiguous,
      observations: t.observations.map((o) => ({
        ...o,
        bbox: [...o.bbox] as Box,
      })),
      velocity: [...t.velocity] as Box,
      firstSeenMs: t.firstSeenMs,
      lastSeenMs: t.lastSeenMs,
      hits: t.hits,
      motion: t.motion,
    }));
  }

  update(
    input: Detection[],
    sourceTimeMs: number,
    captureEpoch: string,
    measurementEligible = true,
  ): TrackedObjectV2[] {
    if (!Number.isFinite(sourceTimeMs) || sourceTimeMs < 0)
      throw new Error("time_discontinuity");
    if (captureEpoch !== this.epoch) {
      const sink = this.diagnostics;
      this.reset();
      this.diagnostics = sink;
      sink?.({ kind: "reset", sourceTimeMs, reason: "epoch_changed" });
      this.epoch = captureEpoch;
    }
    // A result that does not advance source time is out of order. The capture
    // path already refuses those; if one arrives anyway it is refused here
    // rather than destroying every identity, which is what v1 did.
    if (sourceTimeMs <= this.previousTime) {
      this.diagnostics?.({
        kind: "reset",
        sourceTimeMs,
        reason: "time_not_advancing",
      });
      return this.view();
    }
    this.previousTime = sourceTimeMs;
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

    this.tracks = this.tracks.filter(
      (t) => sourceTimeMs - t.lastSeenMs <= this.tuning.expiryMs,
    );
    for (const t of this.tracks) t.observed = false;

    const matched = new Set<number>();
    const nearest = new Map<
      number,
      { rejection: RejectionReason; iou: number; relative: number }
    >();

    const candidate = (t: InternalTrack, d: Detection): Candidate => {
      const dtMs = sourceTimeMs - t.lastSeenMs;
      const dt = clamp(dtMs, 0, this.tuning.maxPredictionMs) / 1000;
      const predicted = t.bbox.map((x, i) => x + t.velocity[i]! * dt) as Box;
      const pc = center(predicted),
        dc = center(d.bbox);
      const overlap = iou(predicted, d.bbox);
      const distance = Math.hypot(pc[0] - dc[0], pc[1] - dc[1]);
      const trackDiagonal = diagonal(t.bbox);
      const relative = distance / Math.max(1e-6, trackDiagonal);
      const travel =
        Math.hypot(
          (t.velocity[0]! + t.velocity[2]!) / 2,
          (t.velocity[1]! + t.velocity[3]!) / 2,
        ) * dt;
      // Scale-aware: the allowance is the track's own size plus how far it was
      // predicted to travel, so distant vehicles are not held to a near-vehicle
      // standard and fast ones are not cut off at a fixed radius.
      // The gate never falls below what this track's own predicted motion
      // requires: refusing a track its own detection creates a new identity,
      // which crowds the scene further and refuses the next one too. A sweep
      // over a tighter, crowd-aware gate (tests/tracking/sweep.test.ts) made
      // both identity switches and false merges worse for exactly that reason.
      const need = Math.max(
        this.tuning.gateFloor,
        travel + trackDiagonal * this.tuning.gateResidual,
      );
      const gate = clamp(
        trackDiagonal * this.tuning.gateDiagonals +
          travel * this.tuning.gateTravelSlack,
        need,
        this.tuning.gateCeiling,
      );
      const ratio = area(d.bbox) / area(t.bbox);
      const maxRatio = Math.max(1.8, 1.6 + 4 * dt);
      const sameGroup = GROUP[t.className] === GROUP[d.className];
      const rejection: RejectionReason | null = !sameGroup
        ? "class_mismatch"
        : distance > gate
          ? "predicted_center_far"
          : ratio > maxRatio || ratio < 1 / maxRatio
            ? "scale_mismatch"
            : null;
      const scaleCost = clamp(Math.abs(Math.log(ratio)) / Math.log(3), 0, 1);
      const cost =
        this.tuning.iouWeight * (1 - overlap) +
        this.tuning.centerWeight * clamp(distance / Math.max(1e-6, gate), 0, 1) +
        this.tuning.scaleWeight * scaleCost +
        (t.className === d.className ? 0 : this.tuning.classPenalty);
      return {
        cost: rejection ? 1e6 : cost,
        rejection: rejection ?? (cost >= this.tuning.maxCost ? "assignment_cost" : null),
        iou: overlap,
        centerDistance: distance,
        relative,
        predicted,
      };
    };

    const associate = (tracks: InternalTrack[], indices: number[]) => {
      if (!tracks.length || !indices.length) return;
      const details = tracks.map((t) =>
        indices.map((index) => candidate(t, detections[index]!)),
      );
      if (this.diagnostics)
        tracks.forEach((t, row) =>
          indices.forEach((index, column) => {
            const c = details[row]![column]!;
            const d = detections[index]!;
            this.diagnostics!({
              kind: "association",
              sourceTimeMs,
              trackId: t.trackId,
              trackClass: t.className,
              detectionClass: d.className,
              previousBox: [...t.bbox] as Box,
              predictedBox: [...c.predicted] as Box,
              candidateBox: [...d.bbox] as Box,
              iou: c.iou,
              centerDistance: c.centerDistance,
              relativeDistance: c.relative,
              timeGapMs: sourceTimeMs - t.lastSeenMs,
              score: d.score,
              cost: c.cost,
              accepted: false,
              rejection: c.rejection,
              trackState: t.state,
            });
            if (c.rejection) {
              const best = nearest.get(index);
              if (!best || c.iou > best.iou)
                nearest.set(index, {
                  rejection: c.rejection,
                  iou: c.iou,
                  relative: c.relative,
                });
            }
          }),
        );
      const costs = details.map((row) => row.map((c) => c.cost));
      hungarian(costs, this.tuning.maxCost).forEach((column, row) => {
        if (column < 0) return;
        const t = tracks[row]!,
          index = indices[column]!,
          d = detections[index]!;
        const chosen = costs[row]![column]!;
        const competingDetection = costs[row]!.some(
          (c, j) => j !== column && Math.abs(c - chosen) < this.tuning.ambiguityMargin,
        );
        const competingTrack = costs.some(
          (r, j) =>
            j !== row && Math.abs(r[column]! - chosen) < this.tuning.ambiguityMargin,
        );
        const classConflict = detections.some(
          (other) =>
            GROUP[other.className] !== GROUP[d.className] &&
            iou(other.bbox, d.bbox) > 0.7,
        );
        this.observe(
          t,
          d,
          sourceTimeMs,
          competingDetection || competingTrack || classConflict,
          measurementEligible,
        );
        matched.add(index);
      });
    };

    const unmatchedTracks = () => this.tracks.filter((t) => !t.observed);
    const free = (predicate: (d: Detection, index: number) => boolean) =>
      detections.flatMap((d, i) =>
        !matched.has(i) && predicate(d, i) ? [i] : [],
      );

    // Stage 1 - confident detections against everything still active. Lost
    // tracks take part, which is what turns a brief miss into a recovery rather
    // than a new identity.
    associate(
      unmatchedTracks().filter(
        (t) =>
          t.state !== "lost" ||
          sourceTimeMs - t.lastSeenMs <= this.tuning.reactivationMs,
      ),
      free((d) => d.score >= this.tuning.highScore),
    );
    // Stage 2 - ByteTrack's contribution: low-confidence boxes may continue an
    // established track, but never start one. This is what a confidence dip on
    // an otherwise perfectly visible vehicle needs.
    associate(
      unmatchedTracks().filter((t) => t.hits >= 2),
      free((d) => d.score < this.tuning.highScore),
    );

    for (const t of this.tracks)
      if (!t.observed) {
        t.state = "lost";
        t.observations = [];
      }

    for (let i = 0; i < detections.length; i++) {
      const d = detections[i]!;
      if (matched.has(i) || d.score < this.tuning.newTrackScore) continue;
      let reason: "no_candidate_track" | "all_candidates_gated" | "capacity_evicted" =
        this.tracks.length ? "all_candidates_gated" : "no_candidate_track";
      if (this.tracks.length >= LIMITS.tracks) {
        let oldestLost = -1;
        for (let index = 0; index < this.tracks.length; index++) {
          const c = this.tracks[index]!;
          if (
            !c.observed &&
            (oldestLost < 0 ||
              c.lastSeenMs < this.tracks[oldestLost]!.lastSeenMs)
          )
            oldestLost = index;
        }
        if (oldestLost < 0) continue;
        this.tracks.splice(oldestLost, 1);
        reason = "capacity_evicted";
      }
      const best = nearest.get(i);
      this.diagnostics?.({
        kind: "new_track",
        sourceTimeMs,
        trackId: this.nextId,
        className: d.className,
        bbox: [...d.bbox] as Box,
        score: d.score,
        reason,
        nearestRejection: best?.rejection ?? null,
        nearestIou: best?.iou ?? 0,
        nearestRelativeDistance: best?.relative ?? 0,
      });
      this.tracks.push({
        trackId: this.nextId++,
        className: d.className,
        score: d.score,
        bbox: [...d.bbox] as Box,
        observed: true,
        state: "tentative",
        ambiguous: false,
        observations: measurementEligible
          ? [{ sourceTimeMs, bbox: [...d.bbox] as Box }]
          : [],
        velocity: [0, 0, 0, 0],
        firstSeenMs: sourceTimeMs,
        lastSeenMs: sourceTimeMs,
        hits: 1,
        motion: "unknown",
        votes: new Map([[d.className, d.score]]),
      });
    }
    return this.view();
  }

  private observe(
    t: InternalTrack,
    d: Detection,
    sourceTimeMs: number,
    ambiguous: boolean,
    measurementEligible: boolean,
  ) {
    const dtMs = sourceTimeMs - t.lastSeenMs;
    const dt = Math.max(1, dtMs) / 1000;
    t.ambiguous = ambiguous;
    // Measurement continuity is stricter than identity continuity: a gap, a
    // reacquisition or an ambiguous frame ends the current speed window even
    // though the identity survives.
    if (dtMs > this.tuning.measurementGapMs || t.state === "lost" || ambiguous)
      t.observations = [];
    const raw = d.bbox.map((x, i) => (x - t.bbox[i]!) / dt) as Box;
    const gain = t.hits >= 2 ? this.tuning.velocityGain : 0.5;
    t.velocity = t.velocity.map((v, i) =>
      clamp(v * (1 - gain) + raw[i]! * gain, -this.tuning.maxVelocity, this.tuning.maxVelocity),
    ) as Box;
    t.bbox = [...d.bbox] as Box;
    t.score = d.score;
    t.lastSeenMs = sourceTimeMs;
    t.observed = true;
    t.hits++;
    t.state = t.hits >= this.tuning.confirmHits ? "confirmed" : "tentative";
    // Decayed, score-weighted vote. One wobbling frame cannot rename a vehicle
    // that has been called a car twenty times.
    for (const [key, value] of t.votes) t.votes.set(key, value * 0.88);
    t.votes.set(d.className, (t.votes.get(d.className) ?? 0) + d.score);
    let bestClass = t.className,
      bestVote = -Infinity;
    for (const [key, value] of t.votes)
      if (value > bestVote) {
        bestVote = value;
        bestClass = key;
      }
    t.className = bestClass;
    t.motion = this.motionOf(t);
    if (!ambiguous && measurementEligible)
      t.observations.push({ sourceTimeMs, bbox: [...d.bbox] as Box });
    t.observations = t.observations.slice(-LIMITS.observations);
  }

  /**
   * Frame-relative motion only. Approach is read from box growth, which is the
   * one depth cue a single uncalibrated camera actually has; it is reported as
   * a direction, never as a rate.
   */
  private motionOf(t: InternalTrack): MotionState {
    if (t.hits < 3) return "unknown";
    const vx = (t.velocity[0]! + t.velocity[2]!) / 2;
    const vy = (t.velocity[1]! + t.velocity[3]!) / 2;
    const growth =
      (t.velocity[2]! - t.velocity[0]!) / Math.max(1e-6, width(t.bbox));
    const lateral = Math.hypot(vx, vy);
    if (Math.abs(growth) > 0.35 && Math.abs(growth) > lateral * 1.5)
      return growth > 0 ? "approaching" : "receding";
    if (lateral < 0.03) return "stationary";
    if (Math.abs(vx) >= Math.abs(vy)) return vx > 0 ? "right" : "left";
    return vy > 0 ? "approaching" : "receding";
  }
}

export type { Observation };
