import { describe, expect, it } from "vitest";
import { suite } from "./suite";
import { stress } from "./stress";
import { evaluate, total, type TrackingMetrics } from "./metrics";
import { TRACKERS } from "./adapters";

/**
 * Head-to-head over the whole evaluation set. This is the evidence behind the
 * tracker promotion decision recorded in docs/TRACKING_EVALUATION.md.
 */
describe("tracker benchmark", () => {
  const results = new Map<string, TrackingMetrics>();
  const perScenario = new Map<string, TrackingMetrics[]>();
  const scenarios = suite();
  for (const tracker of TRACKERS) {
    const rows = scenarios.map((s) => evaluate(s.name, s, tracker.run));
    perScenario.set(tracker.name, rows);
    results.set(tracker.name, total(rows));
  }

  it("reports the comparison", () => {
    const header =
      "tracker".padEnd(22) +
      "ids/gt  worst  idsw  frag  merge   idf1   mota    MT/ML";
    const line = (name: string, m: TrackingMetrics) =>
      name.padEnd(22) +
      m.idsPerGroundTruth.toFixed(2).padStart(6) +
      String(m.worstIdsForOneObject).padStart(7) +
      String(m.idSwitches).padStart(6) +
      String(m.fragmentations).padStart(6) +
      String(m.falseMerges).padStart(7) +
      m.idf1.toFixed(3).padStart(7) +
      m.mota.toFixed(3).padStart(7) +
      `   ${m.mostlyTracked}/${m.mostlyLost}`;
    console.log(
      "\n" +
        header +
        "\n" +
        [...results].map(([name, m]) => line(name, m)).join("\n"),
    );
    const v1 = perScenario.get("time_aware_iou_v1")!;
    const v2 = perScenario.get("time_aware_iou_v2")!;
    console.log(
      "\nper scenario, v1 -> v2 distinct IDs per vehicle\n" +
        scenarios
          .map(
            (s, i) =>
              `${s.name.padEnd(24)} ${v1[i]!.idsPerGroundTruth.toFixed(2)} -> ${v2[i]!.idsPerGroundTruth.toFixed(2)}   idsw ${v1[i]!.idSwitches} -> ${v2[i]!.idSwitches}   merge ${v1[i]!.falseMerges} -> ${v2[i]!.falseMerges}`,
          )
          .join("\n"),
    );
    expect(results.size).toBe(TRACKERS.length);
  });

  /**
   * The promotion gate from the release brief: identity continuity must improve
   * materially, and it must not be bought with false merges.
   */
  it("promotes v2 only if identity improves without merging vehicles", () => {
    const v1 = results.get("time_aware_iou_v1")!;
    const v2 = results.get("time_aware_iou_v2")!;
    expect(v2.idSwitches).toBeLessThan(v1.idSwitches * 0.5);
    expect(v2.idsPerGroundTruth).toBeLessThan(1.35);
    expect(v2.falseMerges).toBeLessThanOrEqual(v1.falseMerges);
    expect(v2.idf1).toBeGreaterThan(v1.idf1);
    expect(v2.mostlyLost).toBeLessThanOrEqual(v1.mostlyLost);
  });

  it("keeps one identity for one vehicle in the continuous case", () => {
    const rows = perScenario.get("time_aware_iou_v2")!;
    const continuous = rows.find((r) => r.name === "single-car-continuous")!;
    expect(continuous.idSwitches).toBe(0);
    expect(continuous.idsPerGroundTruth).toBe(1);
  });

  it("never merges the two crossing vehicles", () => {
    for (const tracker of ["time_aware_iou_v2"]) {
      const row = perScenario
        .get(tracker)!
        .find((r) => r.name === "two-cars-crossing")!;
      expect(row.falseMerges).toBe(0);
    }
  });
});

describe("tracker benchmark, hard tier", () => {
  const scenarios = stress();
  const results = new Map<string, TrackingMetrics>();
  const perScenario = new Map<string, TrackingMetrics[]>();
  for (const tracker of TRACKERS) {
    const rows = scenarios.map((s) => evaluate(s.name, s, tracker.run));
    perScenario.set(tracker.name, rows);
    results.set(tracker.name, total(rows));
  }

  it("reports the hard comparison", () => {
    const line = (name: string, m: TrackingMetrics) =>
      name.padEnd(22) +
      m.idsPerGroundTruth.toFixed(2).padStart(6) +
      String(m.worstIdsForOneObject).padStart(7) +
      String(m.idSwitches).padStart(6) +
      String(m.fragmentations).padStart(6) +
      String(m.falseMerges).padStart(7) +
      m.idf1.toFixed(3).padStart(7) +
      m.mota.toFixed(3).padStart(7) +
      `   ${m.mostlyTracked}/${m.mostlyLost}`;
    console.log(
      "\n" +
        "tracker".padEnd(22) +
        "ids/gt  worst  idsw  frag  merge   idf1   mota    MT/ML\n" +
        [...results].map(([name, m]) => line(name, m)).join("\n"),
    );
    console.log(
      "\nhard tier, per scenario (ids/gt | idsw | merges)\n" +
        scenarios
          .map((s, i) => {
            const cell = (name: string) => {
              const m = perScenario.get(name)![i]!;
              return `${m.idsPerGroundTruth.toFixed(2)}|${m.idSwitches}|${m.falseMerges}`;
            };
            return (
              s.name.padEnd(20) +
              TRACKERS.map((t) => cell(t.name).padStart(12)).join("")
            );
          })
          .join("\n") +
        "\n" +
        " ".repeat(20) +
        TRACKERS.map((t) => t.name.slice(0, 11).padStart(12)).join(""),
    );
    expect(results.size).toBe(TRACKERS.length);
  });

  /**
   * The safety half of the promotion gate. A tracker can drive identity
   * switches to zero by absorbing its neighbours, so the tracker being replaced
   * sets the ceiling on merges while identity must improve outright.
   */
  it("does not buy identity continuity with false merges", () => {
    const v1 = results.get("time_aware_iou_v1")!;
    const v2 = results.get("time_aware_iou_v2")!;
    expect(v2.idSwitches).toBeLessThan(v1.idSwitches);
    expect(v2.idsPerGroundTruth).toBeLessThan(v1.idsPerGroundTruth);
    expect(v2.falseMerges).toBeLessThan(v1.falseMerges);
  });

  /**
   * v2 is kept rather than adopting a reference tracker wholesale: it must at
   * least match them on the metrics that describe a usable overlay, since its
   * reason to exist is the source-time and measurement contract they lack.
   */
  it("is not worse than the reference trackers it is measured against", () => {
    const v2 = results.get("time_aware_iou_v2")!;
    for (const reference of ["bytetrack_reference", "botsort_reference"]) {
      const r = results.get(reference)!;
      expect(v2.idf1).toBeGreaterThanOrEqual(r.idf1);
      expect(v2.mota).toBeGreaterThanOrEqual(r.mota);
      expect(v2.fragmentations).toBeLessThanOrEqual(r.fragmentations);
      expect(v2.idSwitches).toBeLessThanOrEqual(r.idSwitches);
    }
  });
});
