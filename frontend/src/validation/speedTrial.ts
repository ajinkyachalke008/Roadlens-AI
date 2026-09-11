/**
 * Speed validation: pairing measured estimates with independent reference
 * speeds, and the error statistics computed from those pairs.
 *
 * This module produces evidence, never accuracy. It records what the system
 * measured, what an operator independently measured, and the difference. It
 * cannot assert that a trial was conducted correctly; that is a property of the
 * physical setup, and the procedure is in docs/SPEED_VALIDATION.md.
 */
import type { SpeedEstimate } from "../geometry/speed";

/** How a reference speed was obtained. Recorded, never inferred. */
export type ReferenceMethod =
  | "gps_speedometer"
  | "radar_gun"
  | "timing_gate"
  | "vehicle_speedometer"
  | "other";

export interface SpeedTrial {
  trialId: string;
  passIndex: number;
  capturedAtIso: string;
  captureEpoch: string;
  calibrationVersion: string;
  trackId: number;
  className: string;
  /** What RoadLens measured, in metres per second. */
  estimatedMps: number;
  /** What the operator independently measured, in metres per second. */
  referenceMps: number;
  referenceMethod: ReferenceMethod;
  /** Estimator quality facts carried from the estimate that was recorded. */
  residualM: number | null;
  sampleCount: number;
  coverageMs: number;
  trajectoryPoints: number;
  notes: string;
}

export interface SpeedErrorSummary {
  trials: number;
  /** Mean absolute error, m/s. Null with no trials. */
  maeMps: number | null;
  medianAbsMps: number | null;
  /**
   * 95th percentile absolute error. Null below P95_MINIMUM_TRIALS, where a p95
   * would describe the sample size rather than the system.
   */
  p95AbsMps: number | null;
  maxAbsMps: number | null;
  /** Mean signed error: positive means RoadLens reads high. */
  biasMps: number | null;
  /** Mean absolute error as a percentage of mean reference speed. */
  maePercent: number | null;
}

/** Minimum trials before a p95 is reported rather than suppressed. */
export const P95_MINIMUM_TRIALS = 20;

const sortedAsc = (values: number[]) => [...values].sort((a, b) => a - b);

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const a = sortedAsc(values);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

/** Linear interpolation between order statistics. */
export function percentile(values: number[], fraction: number): number | null {
  if (!values.length || !(fraction >= 0 && fraction <= 1)) return null;
  const a = sortedAsc(values);
  if (a.length === 1) return a[0]!;
  const position = fraction * (a.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return a[lower]!;
  return a[lower]! + (position - lower) * (a[upper]! - a[lower]!);
}

export function summarize(trials: readonly SpeedTrial[]): SpeedErrorSummary {
  const signed = trials.map((t) => t.estimatedMps - t.referenceMps);
  const absolute = signed.map(Math.abs);
  const mean = (values: number[]) =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  const mae = mean(absolute);
  const meanReference = mean(trials.map((t) => t.referenceMps));
  return {
    trials: trials.length,
    maeMps: mae,
    medianAbsMps: median(absolute),
    p95AbsMps:
      trials.length >= P95_MINIMUM_TRIALS ? percentile(absolute, 0.95) : null,
    maxAbsMps: absolute.length ? Math.max(...absolute) : null,
    biasMps: mean(signed),
    maePercent:
      mae !== null && meanReference !== null && meanReference > 0
        ? (mae / meanReference) * 100
        : null,
  };
}

export interface TrialInput {
  captureEpoch: string;
  calibrationVersion: string;
  trackId: number;
  className: string;
  estimate: SpeedEstimate;
  referenceMps: number;
  referenceMethod: ReferenceMethod;
  notes?: string;
}

/**
 * Session-scoped recorder. Trials live in RAM for the session only, exactly
 * like reports: no storage, no upload, cleared when the session ends.
 */
export class SpeedValidationSession {
  /** Bounded like every other in-memory collection in the application. */
  static readonly maxTrials = 200;
  private entries: SpeedTrial[] = [];

  get trials(): readonly SpeedTrial[] {
    return this.entries;
  }

  /**
   * Records one pass. A trial requires a numeric estimate and a positive
   * reference; an unmeasurable pass is not a zero-error trial and is refused.
   */
  record(input: TrialInput): SpeedTrial {
    if (input.estimate.speedMps === null)
      throw new Error(
        `speed_unavailable: ${input.estimate.reason ?? "no estimate"}`,
      );
    if (!Number.isFinite(input.referenceMps) || input.referenceMps <= 0)
      throw new Error("reference_invalid: enter a measured positive speed");
    if (!input.calibrationVersion)
      throw new Error("calibration_required: calibrate before validating");
    if (this.entries.length >= SpeedValidationSession.maxTrials)
      throw new Error("trial_limit_reached");
    const trial: SpeedTrial = {
      trialId: crypto.randomUUID(),
      passIndex: this.entries.length + 1,
      capturedAtIso: new Date().toISOString(),
      captureEpoch: input.captureEpoch,
      calibrationVersion: input.calibrationVersion,
      trackId: input.trackId,
      className: input.className,
      estimatedMps: input.estimate.speedMps,
      referenceMps: input.referenceMps,
      referenceMethod: input.referenceMethod,
      residualM: input.estimate.residualM,
      sampleCount: input.estimate.sampleCount,
      coverageMs: input.estimate.coverageMs,
      trajectoryPoints: input.estimate.trajectory.length,
      notes: (input.notes ?? "").slice(0, 500),
    };
    this.entries.push(trial);
    return trial;
  }

  remove(trialId: string) {
    this.entries = this.entries.filter((t) => t.trialId !== trialId);
    this.entries.forEach((trial, index) => (trial.passIndex = index + 1));
  }

  clear() {
    this.entries = [];
  }

  get summary(): SpeedErrorSummary {
    return summarize(this.entries);
  }
}

export const validationNotice =
  "Measured prototype accuracy from operator-recorded reference speeds. Not a " +
  "certified or enforcement-grade calibration. Each trial's accuracy depends on " +
  "the physical setup and the reference method recorded with it.";
