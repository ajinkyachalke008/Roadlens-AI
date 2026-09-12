import { describe, it } from "vitest";
import { suite } from "./suite";
import { stress } from "./stress";
import { evaluate, total, type TrackerOutput } from "./metrics";
import { TimeAwareTrackerV2, V2 } from "../../frontend/src/tracking/trackerV2";

/**
 * Parameter sweep behind the shipped constants.
 *
 * `maxCost` and `neighbourShare` trade identity continuity against false
 * merges, and picking them from one clip is exactly the brittleness the release
 * brief warns about. Both tiers are scored together so a setting cannot win by
 * overfitting the adversarial set at the cost of ordinary traffic.
 */
describe("v2 parameter sweep", () => {
  it("reports the identity/merge trade-off", () => {
    const scenarios = [...suite(), ...stress()];
    const rows: string[] = [];
    for (const maxCost of [0.55, 0.62, 0.68, 0.72, 0.8]) {
      for (const gateDiagonals of [0.6, 0.9, 1.2]) {
        const tuning = { ...V2, maxCost, gateDiagonals };
        const t = total(
          scenarios.map((s) =>
            evaluate(s.name, s, (scenario) => {
              const tracker = new TimeAwareTrackerV2(tuning);
              return scenario.frames.map((frame) =>
                tracker
                  .update(frame.detections, frame.sourceTimeMs, "eval", false)
                  .map<TrackerOutput>((x) => ({
                    trackId: x.trackId,
                    bbox: x.bbox,
                    observed: x.observed,
                  })),
              );
            }),
          ),
        );
        rows.push(
          `maxCost=${maxCost.toFixed(2)} gateDiag=${gateDiagonals.toFixed(2)}  ids/gt=${t.idsPerGroundTruth.toFixed(3)} idsw=${String(t.idSwitches).padStart(3)} merge=${String(t.falseMerges).padStart(3)} frag=${String(t.fragmentations).padStart(3)} idf1=${t.idf1.toFixed(4)} mota=${t.mota.toFixed(4)}`,
        );
      }
    }
    console.log("\n" + rows.join("\n"));
  });
});
