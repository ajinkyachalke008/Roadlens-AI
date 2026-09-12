/**
 * CLEAR-MOT and identity metrics over a scenario run.
 *
 * The headline number for RoadLens is `idsPerGroundTruth`: how many distinct
 * track IDs one physical vehicle collects while continuously observed. IDF1 and
 * MOTA are reported alongside because a tracker can trivially drive ID switches
 * to zero by merging vehicles, and `falseMerges` is what catches that.
 */
import { hungarian, iou, type Box } from "../../frontend/src/tracking/tracker";
import type { Scenario } from "./scenarios";

export interface TrackerOutput {
  trackId: number;
  bbox: Box;
  observed: boolean;
}
export type TrackerRun = (scenario: Scenario) => TrackerOutput[][];

export interface TrackingMetrics {
  name: string;
  frames: number;
  groundTruthBoxes: number;
  hypotheses: number;
  /** Identity switches, CLEAR-MOT definition. */
  idSwitches: number;
  /** Interruptions of an already-tracked ground-truth trajectory. */
  fragmentations: number;
  /** One hypothesis ID covering more than one physical object. */
  falseMerges: number;
  falsePositives: number;
  misses: number;
  mota: number;
  idf1: number;
  /** Mean distinct hypothesis IDs per ground-truth object. 1.0 is perfect. */
  idsPerGroundTruth: number;
  worstIdsForOneObject: number;
  mostlyTracked: number;
  mostlyLost: number;
}

const MATCH_IOU = 0.5;

export function evaluate(
  name: string,
  scenario: Scenario,
  run: TrackerRun,
): TrackingMetrics {
  const outputs = run(scenario);
  let idSwitches = 0,
    fragmentations = 0,
    falsePositives = 0,
    misses = 0,
    groundTruthBoxes = 0,
    hypotheses = 0;
  /** Last hypothesis each ground-truth object was matched to. */
  const lastMatch = new Map<number, number>();
  const wasTracked = new Map<number, boolean>();
  const idsSeen = new Map<number, Set<number>>();
  const trackedFrames = new Map<number, number>();
  const gtFrames = new Map<number, number>();
  /** Co-occurrence counts for IDF1 and false merges. */
  const pairs = new Map<string, number>();
  const gtIds = new Set<number>();
  const hypIds = new Set<number>();

  scenario.frames.forEach((frame, index) => {
    const tracks = (outputs[index] ?? []).filter((t) => t.observed);
    hypotheses += tracks.length;
    for (const id of frame.present.keys()) {
      gtIds.add(id);
      gtFrames.set(id, (gtFrames.get(id) ?? 0) + 1);
    }
    for (const t of tracks) hypIds.add(t.trackId);
    const gt = [...frame.present.entries()];
    groundTruthBoxes += gt.length;
    const matched = new Map<number, number>();
    const usedHyp = new Set<number>();
    // CLEAR-MOT preserves existing correspondences before re-matching, so an
    // arbitrary re-pairing is not scored as an identity switch.
    for (const [id] of gt) {
      const previous = lastMatch.get(id);
      if (previous === undefined) continue;
      const hyp = tracks.find((t) => t.trackId === previous);
      if (!hyp || usedHyp.has(previous)) continue;
      if (iou(frame.present.get(id)!, hyp.bbox) >= MATCH_IOU) {
        matched.set(id, previous);
        usedHyp.add(previous);
      }
    }
    const freeGt = gt.filter(([id]) => !matched.has(id));
    const freeHyp = tracks.filter((t) => !usedHyp.has(t.trackId));
    if (freeGt.length && freeHyp.length) {
      const costs = freeGt.map(([, gtBox]) =>
        freeHyp.map((h) => 1 - iou(gtBox, h.bbox)),
      );
      hungarian(costs, 1 - MATCH_IOU).forEach((column, row) => {
        if (column < 0) return;
        matched.set(freeGt[row]![0], freeHyp[column]!.trackId);
        usedHyp.add(freeHyp[column]!.trackId);
      });
    }
    for (const [id] of gt) {
      const hyp = matched.get(id);
      if (hyp === undefined) {
        misses++;
        if (wasTracked.get(id)) {
          fragmentations++;
          wasTracked.set(id, false);
        }
        continue;
      }
      const previous = lastMatch.get(id);
      if (previous !== undefined && previous !== hyp) idSwitches++;
      lastMatch.set(id, hyp);
      wasTracked.set(id, true);
      trackedFrames.set(id, (trackedFrames.get(id) ?? 0) + 1);
      if (!idsSeen.has(id)) idsSeen.set(id, new Set());
      idsSeen.get(id)!.add(hyp);
      const key = `${id}:${hyp}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
    falsePositives += tracks.length - usedHyp.size;
  });

  // IDF1 needs one global ground-truth/hypothesis pairing, chosen to maximise
  // the frames on which the pair coincides.
  const gtList = [...gtIds],
    hypList = [...hypIds];
  let idTruePositives = 0;
  if (gtList.length && hypList.length) {
    const best = Math.max(
      1,
      ...[...pairs.values()],
    );
    const costs = gtList.map((g) =>
      hypList.map((h) => 1 - (pairs.get(`${g}:${h}`) ?? 0) / best),
    );
    hungarian(costs, 1).forEach((column, row) => {
      if (column < 0) return;
      idTruePositives += pairs.get(`${gtList[row]}:${hypList[column]}`) ?? 0;
    });
  }
  const idFalseNegatives = groundTruthBoxes - idTruePositives;
  const idFalsePositives = hypotheses - idTruePositives;

  // A hypothesis that covers two physical objects is a false merge, counted
  // once per extra object it absorbed.
  const objectsPerHyp = new Map<number, Set<number>>();
  for (const key of pairs.keys()) {
    const [g, h] = key.split(":").map(Number) as [number, number];
    if (!objectsPerHyp.has(h)) objectsPerHyp.set(h, new Set());
    objectsPerHyp.get(h)!.add(g);
  }
  const falseMerges = [...objectsPerHyp.values()].reduce(
    (sum, set) => sum + Math.max(0, set.size - 1),
    0,
  );

  const counts = gtList.map((id) => idsSeen.get(id)?.size ?? 0);
  const ratios = gtList.map(
    (id) => (trackedFrames.get(id) ?? 0) / Math.max(1, gtFrames.get(id) ?? 1),
  );
  return {
    name,
    frames: scenario.frames.length,
    groundTruthBoxes,
    hypotheses,
    idSwitches,
    fragmentations,
    falseMerges,
    falsePositives,
    misses,
    mota:
      groundTruthBoxes === 0
        ? 1
        : 1 - (misses + falsePositives + idSwitches) / groundTruthBoxes,
    idf1:
      2 * idTruePositives /
      Math.max(1, 2 * idTruePositives + idFalsePositives + idFalseNegatives),
    idsPerGroundTruth: counts.length
      ? counts.reduce((a, b) => a + b, 0) / counts.length
      : 0,
    worstIdsForOneObject: counts.length ? Math.max(...counts) : 0,
    mostlyTracked: ratios.filter((r) => r >= 0.8).length,
    mostlyLost: ratios.filter((r) => r <= 0.2).length,
  };
}

export function total(metrics: TrackingMetrics[]): TrackingMetrics {
  const sum = (pick: (m: TrackingMetrics) => number) =>
    metrics.reduce((a, m) => a + pick(m), 0);
  const groundTruthBoxes = sum((m) => m.groundTruthBoxes);
  const misses = sum((m) => m.misses),
    falsePositives = sum((m) => m.falsePositives),
    idSwitches = sum((m) => m.idSwitches);
  const weighted = (pick: (m: TrackingMetrics) => number) =>
    metrics.length ? sum(pick) / metrics.length : 0;
  return {
    name: "TOTAL",
    frames: sum((m) => m.frames),
    groundTruthBoxes,
    hypotheses: sum((m) => m.hypotheses),
    idSwitches,
    fragmentations: sum((m) => m.fragmentations),
    falseMerges: sum((m) => m.falseMerges),
    falsePositives,
    misses,
    mota:
      groundTruthBoxes === 0
        ? 1
        : 1 - (misses + falsePositives + idSwitches) / groundTruthBoxes,
    idf1: weighted((m) => m.idf1),
    idsPerGroundTruth: weighted((m) => m.idsPerGroundTruth),
    worstIdsForOneObject: Math.max(...metrics.map((m) => m.worstIdsForOneObject), 0),
    mostlyTracked: sum((m) => m.mostlyTracked),
    mostlyLost: sum((m) => m.mostlyLost),
  };
}
