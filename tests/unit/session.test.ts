import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../../frontend/src/session/store";
import {
  csvCell,
  csvExport,
  jsonExport,
} from "../../frontend/src/session/export";
import { LIMITS } from "../../shared/src/limits";
import { frame, policy, report, uuid } from "../contracts/fixtures";
import { PolicySchema, type FrameResult } from "../../shared/src/schemas";

// Synthetic qualified motion uses the real manifest identity only for serialized sizing.
// This fixture is not a measured field-speed or detector-accuracy result.
function fullPrecisionCandidate(roadLabel: string) {
  const f: FrameResult = frame(17999);
  f.sourceTimeMs = 3599800.123456789;
  f.modelId = "yolo26n-coco-e2e-416-fp32-v1";
  f.modelSha256 =
    "703143276b5c7c32c18299510f490b3079e256fbd7866d891a1ef030a640ea21";
  f.calibrationVersion = uuid(700);
  f.policyVersion = uuid(600);
  f.tracks[0] = {
    ...f.tracks[0]!,
    trackId: 10423,
    score: 0.8765432109876543,
    speedMps: 16.782345678901234,
    speedStatus: "valid_estimate",
    speedReason: null,
    ruleState: "candidate",
  };
  f.stats.validSpeedCount = 1;
  f.stats.averageSpeedMps = f.tracks[0].speedMps;
  return {
    frame: f,
    policy: {
      ...policy(),
      version: uuid(600),
      roadLabel,
      speedLimitMps: 13.41119999999468,
      demoMarginMps: 2.2351999999991134,
    },
    summary: {
      trajectory: Array.from(
        { length: 8 },
        (_, i): [number, number, number] => [
          3597000.123456789 + i * 400.123456789,
          -123.45678901234567 + i * 5.123456789012345,
          47.123456789012345 + i * 0.123456789012345,
        ],
      ),
      residualM: 0.17234567890123456,
      coverageMs: 2800.864197523,
    },
  };
}

describe("B22/B24/B46 RAM report and evidence stores (synthetic metadata)", () => {
  it("rejects an explicit missing or predicted track rather than choosing another object", () => {
    const store = new SessionStore(),
      f = frame();
    expect(() =>
      store.save(f, policy(), new Blob(["image"]), "observation", 999),
    ).toThrow(/not observed/);
    f.tracks[0]!.observed = false;
    expect(() => store.save(f, policy(), undefined, "observation", 1)).toThrow(
      /not observed/,
    );
    expect(store.reports.size).toBe(0);
    expect(store.evidenceCount).toBe(0);
  });
  it("marks an empty-scene observation as unmeasured instead of a qualified estimate", () => {
    const store = new SessionStore(),
      f = frame();
    f.tracks = [];
    f.stats.counts.car = 0;
    expect(store.save(f, policy())).toMatchObject({
      kind: "observation",
      trackId: null,
      speedMps: null,
      validityReasons: ["no_observed_object"],
    });
    expect(() => store.save(f, policy(), undefined, "speed_candidate")).toThrow(
      /observed track/,
    );
  });
  it("requires the frozen policy version belonging to the analyzed event frame", () => {
    const store = new SessionStore(),
      p = { ...policy(), version: uuid(700) };
    expect(() => store.save(frame(), p, new Blob(["image"]))).toThrow(
      /policy does not match/,
    );
    expect(store.reports.size).toBe(0);
    expect(store.evidenceCount).toBe(0);
  });
  it.each([
    {
      label: "normal road label",
      roadLabel: "North approach — Hackathon demo",
      expectedBytes: 1662,
    },
    {
      label: "maximum ASCII road label",
      roadLabel: "R".repeat(80),
      expectedBytes: 1709,
    },
    {
      label: "maximum CJK road label",
      roadLabel: "界".repeat(80),
      expectedBytes: 1869,
    },
  ])(
    "fits an eight-point full-precision candidate with $label under 2 KiB",
    ({ roadLabel, expectedBytes }) => {
      const store = new SessionStore(),
        input = fullPrecisionCandidate(roadLabel);
      const saved = store.save(
        input.frame,
        input.policy,
        new Blob(["synthetic-image"]),
        "speed_candidate",
        10423,
        uuid(800),
        input.summary,
      );
      const bytes = new TextEncoder().encode(JSON.stringify(saved)).length;
      expect(bytes).toBe(expectedBytes);
      expect(bytes).toBeLessThanOrEqual(2048);
      expect(saved.evidenceSummary.trajectory).toHaveLength(8);
    },
  );
  it("rejects control-character road labels before retaining any report or evidence", () => {
    const store = new SessionStore(),
      input = fullPrecisionCandidate("\u0000".repeat(80));
    expect(PolicySchema.safeParse(input.policy).success).toBe(false);
    expect(() =>
      store.save(
        input.frame,
        input.policy,
        new Blob(["synthetic-image"]),
        "speed_candidate",
        10423,
        uuid(800),
        input.summary,
      ),
    ).toThrow();
    expect(store.evidenceCount).toBe(0);
    expect(store.reports.size).toBe(0);
  });
  it("saves a real-shaped observation with unavailable speed and image retention off by default", () => {
    const store = new SessionStore();
    const r = store.save(frame(), policy());
    expect(r).toMatchObject({
      kind: "observation",
      speedMps: null,
      evidenceState: "none",
      evidenceId: null,
    });
    expect(store.reports.size).toBe(1);
    expect(store.evidenceCount).toBe(0);
  });
  it("retains one bounded truthful Showcase observation and publishes it once", () => {
    const store = new SessionStore(),
      published = vi.fn(),
      f = frame(30);
    f.sourceTimeMs = 6_123;
    f.tracks[0] = {
      ...f.tracks[0]!,
      trackId: 8,
      className: "truck",
      score: 0.91,
      trackState: "confirmed",
      observedMs: 1_400,
    };
    store.onReport = published;
    const saved = store.save(
      f,
      policy(),
      new Blob(["showcase-frame"]),
      "observation",
      8,
      uuid(900),
      undefined,
      {
        plateStatus: "unavailable",
        plateText: null,
        plateConfidence: null,
        plateSupportingFrames: 0,
        plateDetectorConfidence: null,
      },
      "showcase",
    );
    expect(saved).toMatchObject({
      reportId: uuid(900),
      frameId: f.frameId,
      captureEpoch: f.captureEpoch,
      sourceTimeMs: 6_123,
      trackId: 8,
      className: "truck",
      score: 0.91,
      kind: "observation",
      speedMps: null,
      validityReasons: ["not_calibrated", "showcase_trigger"],
      plateStatus: "unavailable",
      plateText: null,
      evidenceState: "available",
    });
    expect(store.reports.size).toBe(1);
    expect(store.evidenceCount).toBe(1);
    expect(published).toHaveBeenCalledTimes(1);
  });
  it("upgrades the same Showcase report to a genuine speed candidate without a duplicate", () => {
    const store = new SessionStore(),
      published = vi.fn(),
      reportId = uuid(901),
      first = frame(31);
    first.tracks[0] = {
      ...first.tracks[0]!,
      trackState: "confirmed",
      observedMs: 1_000,
    };
    store.onReport = published;
    store.save(
      first,
      policy(),
      new Blob(["initial"]),
      "observation",
      1,
      reportId,
      undefined,
      {
        plateStatus: "pending",
        plateText: null,
        plateConfidence: null,
        plateSupportingFrames: 0,
        plateDetectorConfidence: null,
      },
      "showcase",
    );
    const qualified = frame(32);
    qualified.calibrationVersion = uuid(700);
    qualified.tracks[0] = {
      ...qualified.tracks[0]!,
      trackState: "confirmed",
      observedMs: 2_000,
      speedMps: 14.2,
      speedStatus: "valid_estimate",
      speedReason: null,
      ruleState: "candidate",
    };
    const summary = {
      trajectory: [
        [qualified.sourceTimeMs - 200, 1, 2],
        [qualified.sourceTimeMs, 2, 3],
      ] as [number, number, number][],
      residualM: 0.2,
      coverageMs: 200,
    };
    expect(
      store.upgradeToSpeedCandidate(
        reportId,
        qualified,
        policy(),
        1,
        summary,
        new Blob(["qualified"]),
      ),
    ).toBe(true);
    expect(store.snapshot()).toHaveLength(1);
    expect(store.reports.get(reportId)).toMatchObject({
      reportId,
      revision: 1,
      frameId: qualified.frameId,
      kind: "speed_candidate",
      speedMps: 14.2,
      calibrationVersion: uuid(700),
      validityReasons: [],
      evidenceSummary: summary,
    });
    expect(store.evidenceCount).toBe(1);
    expect(published).toHaveBeenCalledTimes(2);
    expect(store.episodeId("same-real-episode", reportId)).toBe(reportId);
    expect(store.episodeId("same-real-episode")).toBe(reportId);
  });
  it("caps reports by FIFO creation and review updates cannot refresh their lifetime", () => {
    const store = new SessionStore();
    for (let i = 1; i <= 200; i++) store.upsert(report(i));
    expect(store.review(uuid(1), 0, "noted")).toBe("ok");
    store.upsert(report(201));
    expect(store.reports.size).toBe(LIMITS.reports);
    expect(store.reports.has(uuid(1))).toBe(false);
    expect(store.reports.has(uuid(2))).toBe(true);
  });
  it("ignores duplicate/lower revisions and accepts a higher review revision", () => {
    const store = new SessionStore();
    const r = report();
    expect(store.upsert(r)).toBe(true);
    expect(store.upsert(r)).toBe(false);
    expect(store.upsert({ ...r, revision: 2, review: "noted" })).toBe(true);
    expect(store.upsert({ ...r, revision: 1 })).toBe(false);
    expect(store.reports.get(r.reportId)!.review).toBe("noted");
  });
  it("serializes expected revisions and rejects nonexistent reports", () => {
    const store = new SessionStore();
    store.upsert(report());
    expect(store.review(uuid(1), 0, "noted")).toBe("ok");
    expect(store.review(uuid(1), 0, "dismissed")).toBe("revision_conflict");
    expect(store.review(uuid(9), 0, "noted")).toBe("report_unavailable");
    expect(store.review(uuid(1), 1, "dismissed")).toBe("ok");
    expect(store.reports.get(uuid(1))!.revision).toBe(2);
  });
  it("clones report inputs, snapshots and policy facts", () => {
    const store = new SessionStore(),
      r = report();
    store.upsert(r);
    r.policy.roadLabel = "mutated";
    const snapshot = store.snapshot();
    snapshot[0]!.policy.roadLabel = "changed";
    expect(store.reports.get(uuid(1))!.policy.roadLabel).toBe(
      "Synthetic test road",
    );
    const p = policy();
    store.save(frame(2), p);
    p.speedLimitMps = 99;
    expect(store.snapshot().at(-1)!.policy.speedLimitMps).toBe(10);
  });
  it("evicts least-recently-used evidence and publishes the changed availability revision", () => {
    const store = new SessionStore(),
      published = vi.fn();
    store.onReport = published;
    for (let i = 1; i <= 20; i++) {
      store.upsert({
        ...report(i),
        evidenceId: uuid(1000 + i),
        evidenceState: "available",
      });
      store.retain(uuid(1000 + i), new Blob(["test-image"]));
    }
    store.image(uuid(1001));
    store.retain(uuid(1021), new Blob(["new-image"]));
    expect(store.evidenceCount).toBe(20);
    expect(store.image(uuid(1001))).toBeDefined();
    expect(store.image(uuid(1002))).toBeUndefined();
    expect(store.reports.get(uuid(2))).toMatchObject({
      evidenceState: "evicted",
      revision: 1,
    });
    expect(published).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: uuid(2), evidenceState: "evicted" }),
    );
  });
  it("enforces the aggregate 8 MiB cap independently of image count", () => {
    const store = new SessionStore(),
      bytes = new Uint8Array(5 * 1024 * 1024);
    store.retain(uuid(1), new Blob([bytes]));
    store.retain(uuid(2), new Blob([bytes]));
    expect(store.evidenceCount).toBe(1);
    expect(store.evidenceSize).toBe(bytes.length);
    expect(store.image(uuid(1))).toBeUndefined();
  });
  it("replacement accounting and oversized rejection cannot leak byte counters", () => {
    const store = new SessionStore();
    store.retain(uuid(1), new Blob(["12345"]));
    store.retain(uuid(1), new Blob(["ab"]));
    expect(store.evidenceSize).toBe(2);
    expect(
      store.retain(
        uuid(2),
        new Blob([new Uint8Array(LIMITS.evidenceBytes + 1)]),
      ),
    ).toBe(false);
    expect(store.evidenceSize).toBe(2);
  });
  it("report FIFO eviction also releases its retained evidence", () => {
    const store = new SessionStore();
    store.upsert({
      ...report(),
      evidenceId: uuid(1000),
      evidenceState: "available",
    });
    store.retain(uuid(1000), new Blob(["123"]));
    for (let i = 2; i <= 201; i++) store.upsert(report(i));
    expect(store.evidenceCount).toBe(0);
    expect(store.evidenceSize).toBe(0);
  });
  it("end-session clear releases reports, images and accounting", () => {
    const store = new SessionStore();
    store.save(frame(), policy(), new Blob(["synthetic-image"]));
    store.clear();
    expect(store.snapshot()).toEqual([]);
    expect(store.evidenceCount).toBe(0);
    expect(store.evidenceSize).toBe(0);
  });
  it("does not claim an oversized unretained image is available", () => {
    const store = new SessionStore();
    const r = store.save(
      frame(),
      policy(),
      new Blob([new Uint8Array(LIMITS.evidenceBytes + 1)]),
    );
    expect(r.evidenceState).not.toBe("available");
    expect(store.evidenceCount).toBe(0);
  });
  it("validates before retaining evidence or mutating existing stores", () => {
    const store = new SessionStore();
    const invalid = { ...policy(), roadLabel: "x".repeat(81) };
    expect(() =>
      store.save(frame(), invalid, new Blob(["synthetic-image"])),
    ).toThrow();
    expect(store.evidenceCount).toBe(0);
    expect(store.reports.size).toBe(0);
  });
  it("deduplicated save returns the existing report and does not retain orphan evidence", () => {
    const store = new SessionStore(),
      published = vi.fn();
    store.onReport = published;
    const first = store.save(
      frame(),
      policy(),
      new Blob(["a"]),
      "observation",
      1,
      uuid(1),
    );
    const again = store.save(
      frame(),
      policy(),
      new Blob(["b"]),
      "observation",
      1,
      uuid(1),
    );
    expect(again).toEqual(first);
    expect(store.evidenceCount).toBe(1);
    expect(published).toHaveBeenCalledTimes(1);
  });
  it("viewer-local evidence eviction preserves source revisions and accepts the next camera review", () => {
    const store = new SessionStore(false),
      published = vi.fn();
    store.onReport = published;
    const sourceReport = {
      ...report(),
      evidenceId: uuid(1001),
      evidenceState: "available" as const,
    };
    store.upsert(sourceReport);
    for (let i = 1; i <= 21; i++)
      store.retain(uuid(1000 + i), new Blob(["synthetic-image"]));
    expect(store.image(uuid(1001))).toBeUndefined();
    expect(store.reports.get(uuid(1))).toMatchObject({
      revision: 0,
      evidenceState: "available",
    });
    expect(published).not.toHaveBeenCalled();
    expect(
      store.upsert({ ...sourceReport, revision: 1, review: "noted" }),
    ).toBe(true);
    expect(store.reports.get(uuid(1))).toMatchObject({
      revision: 1,
      review: "noted",
    });
  });
  it("keeps episode retry IDs stable at the ledger cap and clears the ledger at session end", () => {
    const store = new SessionStore(),
      first = store.episodeId("synthetic-epoch:1:speed_candidate:policy:0");
    expect(first).toMatch(/^[a-f0-9-]{36}$/);
    for (let i = 1; i < 1000; i++)
      expect(store.episodeId(`synthetic-episode-${i}`)).not.toBeNull();
    expect(store.episodeId("overflow")).toBeNull();
    expect(store.episodeId("synthetic-epoch:1:speed_candidate:policy:0")).toBe(
      first,
    );
    store.clear();
    expect(store.episodeId("overflow")).not.toBeNull();
    expect(
      store.episodeId("synthetic-epoch:1:speed_candidate:policy:0"),
    ).not.toBe(first);
  });
  it("publishes a new revision when plate localization evidence improves", () => {
    const store = new SessionStore();
    const published = vi.fn();
    store.onReport = published;
    const saved = store.save(
      frame(),
      policy(),
      undefined,
      "observation",
      1,
      uuid(1900),
      undefined,
      {
        plateStatus: "unreadable",
        plateText: null,
        plateConfidence: null,
        plateSupportingFrames: 0,
        plateDetectorConfidence: null,
      },
    );
    expect(
      store.applyPlate(saved.reportId, {
        plateStatus: "unreadable",
        plateText: null,
        plateConfidence: null,
        plateSupportingFrames: 0,
        plateDetectorConfidence: 0.84,
      }),
    ).toBe(true);
    expect(store.reports.get(saved.reportId)).toMatchObject({
      revision: 1,
      plateDetectorConfidence: 0.84,
    });
    expect(published).toHaveBeenCalledTimes(2);
  });
});
describe("B25 explicit safe JSON/CSV exports", () => {
  it("preserves null speed and excludes pairing capabilities from JSON", () => {
    const parsed = JSON.parse(jsonExport([report()]));
    expect(parsed.reports[0].speedMps).toBeNull();
    expect(parsed.notice).toContain("cannot be revoked");
    expect(JSON.stringify(parsed)).not.toMatch(
      /ownerToken|viewerToken|pairingCode/,
    );
  });
  it.each([
    "=SUM(A1:A2)",
    "+cmd",
    "-formula",
    "@SUM(A1)",
    "  =formula",
    "\t=1",
    "\r=1",
  ])("escapes spreadsheet formula prefix %j", (value) => {
    expect(csvCell(value)).toBe("\"'" + value.replaceAll('"', '""') + '"');
  });
  it("quotes delimiters, embedded quotes and newline data without inventing null values", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(0)).toBe('"0"');
  });
  it("exports explicit source mode and empty unavailable speed cells", () => {
    const output = csvExport([report()]);
    expect(output).toContain('"synthetic_test"');
    // A report that never ran plate recognition exports empty plate cells
    // rather than omitting the columns, so every row keeps the same shape.
    expect(output).toContain('"car","1","","","","","","pending","0"');
    expect(output).not.toContain("NaN");
  });
});
