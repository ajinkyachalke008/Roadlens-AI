import { describe, it } from "vitest";
import { build, linear, type NoiseModel } from "./scenarios";
import { evaluate, type TrackerOutput } from "./metrics";
import { TimeAwareTracker } from "../../frontend/src/tracking/tracker";

/**
 * Which input property actually drives fragmentation? One traversal is re-run
 * with a single noise dimension varied at a time, so the conclusion is not an
 * artefact of one combined noise setting.
 */
describe("baseline sensitivity", () => {
  const run = (scenario: Parameters<typeof evaluate>[1]) => {
    const tracker = new TimeAwareTracker();
    return scenario.frames.map((frame) =>
      tracker
        .update(frame.detections, frame.sourceTimeMs, "eval", false)
        .map<TrackerOutput>((t) => ({
          trackId: t.trackId,
          bbox: t.bbox,
          observed: t.observed,
        })),
    );
  };
  const traversal = (hz: number, noise: Partial<NoiseModel>, size = 0.16) =>
    build({
      name: "traversal",
      purpose: "sensitivity probe",
      hz,
      durationMs: 5000,
      objects: [
        linear({
          id: 1,
          from: [0.15, 0.58],
          to: [0.85, 0.62],
          size: [size, size * 0.8],
          startMs: 0,
          endMs: 5000,
        }),
      ],
      noise: { seed: 7, ...noise },
    });

  it("isolates class flips, dropout, jitter, cadence and object size", () => {
    const rows: string[] = [];
    const probe = (label: string, scenario: ReturnType<typeof traversal>) => {
      const m = evaluate(label, scenario, run);
      rows.push(
        `${label.padEnd(34)} ids/gt=${m.idsPerGroundTruth.toFixed(2)} idsw=${String(m.idSwitches).padStart(3)} frag=${String(m.fragmentations).padStart(3)}`,
      );
    };
    const clean = { classFlip: 0, dropout: 0, jitter: 0.01 };
    probe("clean 10Hz", traversal(10, clean));
    probe("classFlip 3% 10Hz", traversal(10, { ...clean, classFlip: 0.03 }));
    probe("classFlip 8% 10Hz", traversal(10, { ...clean, classFlip: 0.08 }));
    probe("dropout 10% 10Hz", traversal(10, { ...clean, dropout: 0.1 }));
    probe("jitter 6% 10Hz", traversal(10, { ...clean, jitter: 0.06 }));
    probe("clean 5Hz", traversal(5, clean));
    probe("clean 3Hz", traversal(3, clean));
    probe("small box 0.05 10Hz", traversal(10, clean, 0.05));
    probe("small box 0.05 5Hz", traversal(5, clean, 0.05));
    probe("small+classFlip 5Hz", traversal(5, { ...clean, classFlip: 0.05 }, 0.05));
    console.log("\n" + rows.join("\n"));
  });
});
