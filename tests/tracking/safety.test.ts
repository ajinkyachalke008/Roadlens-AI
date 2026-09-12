import { describe, expect, it } from "vitest";
import { stress } from "./stress";
import { suite } from "./suite";
import { TimeAwareTrackerV2 } from "../../frontend/src/tracking/trackerV2";

/**
 * A false merge is not by itself a measurement error: what matters is whether
 * the tracker knows it is uncertain. Every quantity the product presents as
 * fact - speed, directed counts, candidate events - is gated on a track being
 * confirmed and unambiguous, so a merge that is flagged ambiguous is contained,
 * while a merge presented confidently is not.
 */
describe("ambiguity contains the residual merges", () => {
  const run = (scenario: ReturnType<typeof stress>[number]) => {
    const tracker = new TimeAwareTrackerV2();
    return scenario.frames.map((frame) =>
      tracker.update(frame.detections, frame.sourceTimeMs, "eval", true),
    );
  };

  it("flags ambiguity in the crowded scene where merges occur", () => {
    const scenario = stress().find((s) => s.name === "small-and-crowded")!;
    const frames = run(scenario);
    const ambiguousFrames = frames.filter((tracks) =>
      tracks.some((t) => t.observed && t.ambiguous),
    ).length;
    expect(ambiguousFrames).toBeGreaterThan(0);
  });

  it("clears the measurement window whenever a track is ambiguous", () => {
    for (const scenario of [...suite(), ...stress()])
      for (const tracks of run(scenario))
        for (const track of tracks)
          if (track.ambiguous) expect(track.observations).toHaveLength(0);
  });

  it("keeps an isolated vehicle unambiguous so speed stays available", () => {
    const scenario = suite().find((s) => s.name === "single-car-continuous")!;
    const frames = run(scenario);
    const late = frames.slice(20).flat();
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((t) => !t.ambiguous)).toBe(true);
    expect(late.at(-1)!.observations.length).toBeGreaterThan(8);
  });

  it("never reports an observation the detector did not produce", () => {
    for (const scenario of [...suite(), ...stress()]) {
      const tracker = new TimeAwareTrackerV2();
      scenario.frames.forEach((frame) => {
        const tracks = tracker.update(
          frame.detections,
          frame.sourceTimeMs,
          "eval",
          true,
        );
        // Observations carry only real detector boxes, never the predicted or
        // interpolated ones the overlay draws between analysis frames.
        for (const track of tracks) {
          const latest = track.observations.at(-1);
          if (!latest || latest.sourceTimeMs !== frame.sourceTimeMs) continue;
          expect(
            frame.detections.some(
              (d) =>
                Math.abs(d.bbox[0] - latest.bbox[0]) < 1e-9 &&
                Math.abs(d.bbox[3] - latest.bbox[3]) < 1e-9,
            ),
          ).toBe(true);
        }
      });
    }
  });
});
