import { expect, it, describe, vi, beforeEach, afterEach } from "vitest";
import {
  P95_MINIMUM_TRIALS,
  SpeedValidationSession,
  median,
  percentile,
  summarize,
} from "../../frontend/src/validation/speedTrial";
import {
  speedValidationCsv,
  speedValidationJson,
} from "../../frontend/src/session/export";
import type { SpeedEstimate } from "../../frontend/src/geometry/speed";

const estimate = (speedMps: number | null, reason: string | null = null) =>
  ({
    speedMps,
    reason,
    residualM: speedMps === null ? null : 0.12,
    coverageMs: 2000,
    sampleCount: 12,
    trajectory: [
      { sourceTimeMs: 0, point: [0, 0] },
      { sourceTimeMs: 1000, point: [10, 0] },
    ],
  }) as SpeedEstimate;

const input = (estimatedMps: number, referenceMps: number) => ({
  captureEpoch: "epoch-1",
  calibrationVersion: "calib-1",
  trackId: 7,
  className: "car",
  estimate: estimate(estimatedMps),
  referenceMps,
  referenceMethod: "gps_speedometer" as const,
});

let uuid = 0;
beforeEach(() => {
  uuid = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `trial-${++uuid}` });
});
afterEach(() => vi.unstubAllGlobals());

describe("order statistics", () => {
  it("median handles odd and even lengths and ignores input order", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it("percentile interpolates between order statistics", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
    // position = 0.5 * 3 = 1.5 → halfway between 2 and 3.
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([1, 2], 1.5)).toBeNull();
  });
});

describe("error summary", () => {
  it("computes MAE, median, bias and max from signed differences", () => {
    const trials = [
      input(11, 10),
      input(9, 10),
      input(13, 10),
    ].map((i) => new SpeedValidationSession().record(i));
    // Signed: +1, -1, +3. Absolute: 1, 1, 3.
    const s = summarize(trials);
    expect(s.trials).toBe(3);
    expect(s.maeMps).toBeCloseTo(5 / 3, 10);
    expect(s.medianAbsMps).toBe(1);
    expect(s.maxAbsMps).toBe(3);
    // Bias keeps sign: the system reads high on balance.
    expect(s.biasMps).toBeCloseTo(1, 10);
    expect(s.maePercent).toBeCloseTo((5 / 3 / 10) * 100, 10);
  });
  it("reports no statistics without trials", () => {
    const s = summarize([]);
    expect(s).toMatchObject({
      trials: 0,
      maeMps: null,
      medianAbsMps: null,
      p95AbsMps: null,
      maxAbsMps: null,
      biasMps: null,
      maePercent: null,
    });
  });
  it("suppresses p95 until the sample supports it", () => {
    const session = new SpeedValidationSession();
    for (let i = 0; i < P95_MINIMUM_TRIALS - 1; i++)
      session.record(input(10 + i * 0.1, 10));
    expect(session.summary.trials).toBe(P95_MINIMUM_TRIALS - 1);
    expect(session.summary.p95AbsMps).toBeNull();
    session.record(input(10, 10));
    expect(session.summary.trials).toBe(P95_MINIMUM_TRIALS);
    expect(session.summary.p95AbsMps).not.toBeNull();
  });
  it("a perfectly accurate set has zero error and zero bias", () => {
    const session = new SpeedValidationSession();
    session.record(input(10, 10));
    session.record(input(20, 20));
    expect(session.summary).toMatchObject({
      maeMps: 0,
      medianAbsMps: 0,
      maxAbsMps: 0,
      biasMps: 0,
      maePercent: 0,
    });
  });
});

describe("trial recording", () => {
  it("refuses an unmeasurable pass rather than recording zero error", () => {
    const session = new SpeedValidationSession();
    expect(() =>
      session.record({
        ...input(10, 10),
        estimate: estimate(null, "sampling_too_sparse"),
      }),
    ).toThrow("sampling_too_sparse");
    expect(session.trials).toHaveLength(0);
  });
  it("refuses a missing or non-positive reference speed", () => {
    const session = new SpeedValidationSession();
    for (const reference of [0, -5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => session.record(input(10, reference))).toThrow(
        "reference_invalid",
      );
    expect(session.trials).toHaveLength(0);
  });
  it("refuses to validate without a calibration version", () => {
    const session = new SpeedValidationSession();
    expect(() =>
      session.record({ ...input(10, 10), calibrationVersion: "" }),
    ).toThrow("calibration_required");
  });
  it("carries estimator quality facts and renumbers after removal", () => {
    const session = new SpeedValidationSession();
    const first = session.record(input(10, 10));
    session.record(input(11, 10));
    const third = session.record(input(12, 10));
    expect(first).toMatchObject({
      passIndex: 1,
      residualM: 0.12,
      sampleCount: 12,
      coverageMs: 2000,
      trajectoryPoints: 2,
      calibrationVersion: "calib-1",
    });
    session.remove(first.trialId);
    expect(session.trials.map((t) => t.passIndex)).toEqual([1, 2]);
    expect(session.trials.map((t) => t.trialId)).not.toContain(first.trialId);
    expect(session.trials.at(-1)!.trialId).toBe(third.trialId);
    session.clear();
    expect(session.trials).toHaveLength(0);
    expect(session.summary.trials).toBe(0);
  });
  it("bounds the session like every other in-memory collection", () => {
    const session = new SpeedValidationSession();
    for (let i = 0; i < SpeedValidationSession.maxTrials; i++)
      session.record(input(10, 10));
    expect(() => session.record(input(10, 10))).toThrow("trial_limit_reached");
    expect(session.trials).toHaveLength(SpeedValidationSession.maxTrials);
  });
});

describe("exports", () => {
  it("JSON carries the notice, summary and derived per-trial error", () => {
    const session = new SpeedValidationSession();
    session.record(input(12, 10));
    const parsed = JSON.parse(speedValidationJson(session.trials));
    expect(parsed.notice).toMatch(/[Nn]ot a certified/);
    expect(parsed.summary.maeMps).toBeCloseTo(2, 10);
    expect(parsed.trials[0]).toMatchObject({
      signedErrorMps: 2,
      absoluteErrorMps: 2,
      referenceMethod: "gps_speedometer",
    });
  });
  it("CSV quotes every cell, uses CRLF rows and neutralises formula injection", () => {
    const session = new SpeedValidationSession();
    session.record({ ...input(8, 10), notes: "=cmd()|calc" });
    const csv = speedValidationCsv(session.trials);
    const rows = csv.split("\r\n");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain("signedErrorMps");
    // Signed error stays negative when the system reads low.
    expect(rows[2]).toContain('"-2"');
    expect(rows[2]).toContain("\"'=cmd()|calc\"");
  });
  it("an empty session still exports a valid header-only document", () => {
    expect(speedValidationCsv([]).split("\r\n")).toHaveLength(2);
    expect(JSON.parse(speedValidationJson([])).trials).toEqual([]);
  });
});
