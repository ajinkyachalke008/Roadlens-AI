import { describe, expect, it } from "vitest";
import { build, linear, type Scenario } from "./scenarios";
import { suite } from "./suite";
import { stress } from "./stress";
import { evaluate, type TrackerOutput } from "./metrics";
import { TimeAwareTrackerV2 } from "../../frontend/src/tracking/trackerV2";
import { TimeAwareTracker } from "../../frontend/src/tracking/tracker";

/**
 * One regression per failure discovered while investigating the reported
 * fragmentation. Each asserts an exact identity-switch count, so a future
 * tuning change that reintroduces the failure fails here rather than in the
 * street.
 */
const run = (scenario: Scenario): TrackerOutput[][] => {
  const tracker = new TimeAwareTrackerV2();
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

const named = (name: string) => {
  const scenario = [...suite(), ...stress()].find((s) => s.name === name);
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  return scenario;
};

const metrics = (name: string) => evaluate(name, named(name), run);

describe("tracker regressions", () => {
  it.each([
    ["single-car-continuous", 0, 1],
    ["fast-lateral", 0, 1],
    ["distant-small-car", 0, 1],
    ["one-frame-miss", 0, 1],
    ["two-frame-miss", 0, 1],
    ["five-frame-occlusion", 0, 1],
    ["confidence-dip", 0, 1],
    ["partial-occlusion", 0, 1],
    ["two-cars-crossing", 0, 1],
    ["parallel-cars", 0, 1],
    ["approaching-vehicle", 0, 1],
    ["class-wobble", 0, 1],
    ["motorcycle", 0, 1],
    ["slow-cadence", 0, 1],
    ["mixed-traffic", 0, 1],
    ["dense-queue", 0, 1],
    ["opposing-lanes", 0, 1],
    ["long-occlusion", 0, 1],
    ["heavy-dropout", 0, 1],
    ["degraded-cadence", 0, 1],
    ["stop-and-go", 0, 1],
  ])("%s keeps one identity per vehicle", (name, switches, idsPerVehicle) => {
    const m = metrics(name as string);
    expect(m.idSwitches).toBe(switches);
    expect(m.idsPerGroundTruth).toBe(idsPerVehicle);
  });

  it("holds one identity across 60 consecutive analysis frames", () => {
    const scenario = named("single-car-continuous");
    expect(scenario.frames.length).toBeGreaterThanOrEqual(60);
    const ids = new Set(
      run(scenario)
        .flat()
        .filter((t) => t.observed)
        .map((t) => t.trackId),
    );
    expect(ids.size).toBe(1);
  });

  it("does not recycle an identity when a different vehicle enters", () => {
    const scenario = named("leave-and-reenter");
    const perFrame = run(scenario);
    const first = perFrame
      .slice(0, 15)
      .flat()
      .filter((t) => t.observed)
      .map((t) => t.trackId);
    const second = perFrame
      .slice(45)
      .flat()
      .filter((t) => t.observed)
      .map((t) => t.trackId);
    expect(new Set(first).size).toBe(1);
    expect(new Set(second).size).toBe(1);
    expect(second[0]).not.toBe(first[0]);
  });

  it("expires a track that stops being detected", () => {
    const tracker = new TimeAwareTrackerV2();
    const detection = {
      className: "car" as const,
      score: 0.9,
      bbox: [0.4, 0.5, 0.56, 0.63] as [number, number, number, number],
    };
    for (let i = 0; i < 5; i++)
      tracker.update([detection], i * 100, "epoch", false);
    expect(tracker.update([], 600, "epoch", false)).toHaveLength(1);
    expect(tracker.update([], 2200, "epoch", false)).toHaveLength(0);
  });

  it("starts fresh identities when the capture epoch changes", () => {
    const tracker = new TimeAwareTrackerV2();
    const detection = {
      className: "car" as const,
      score: 0.9,
      bbox: [0.4, 0.5, 0.56, 0.63] as [number, number, number, number],
    };
    for (let i = 0; i < 4; i++)
      tracker.update([detection], i * 100, "first", false);
    const before = tracker.update([detection], 400, "first", false)[0]!.trackId;
    const after = tracker.update([detection], 0, "second", false)[0]!.trackId;
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(1);
  });

  /**
   * The v1 behaviour this replaces: a source time that failed to advance wiped
   * every identity. The ordering gate in CameraCapture already refuses such a
   * result, so reaching the tracker at all means something upstream is wrong -
   * and destroying the scene is the worst available response.
   */
  it("refuses an out-of-order update without destroying identities", () => {
    const tracker = new TimeAwareTrackerV2();
    const detection = {
      className: "car" as const,
      score: 0.9,
      bbox: [0.4, 0.5, 0.56, 0.63] as [number, number, number, number],
    };
    for (let i = 0; i < 4; i++)
      tracker.update([detection], i * 100, "epoch", false);
    const id = tracker.update([detection], 400, "epoch", false)[0]!.trackId;
    const stale = tracker.update([detection], 250, "epoch", false);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.trackId).toBe(id);
    const legacy = new TimeAwareTracker();
    for (let i = 0; i < 4; i++)
      legacy.update([detection], i * 100, "epoch", false);
    expect(legacy.update([detection], 250, "epoch", false)).toHaveLength(0);
  });

  it("does not let a low-confidence detection create an identity", () => {
    const tracker = new TimeAwareTrackerV2();
    const faint = {
      className: "car" as const,
      score: 0.45,
      bbox: [0.4, 0.5, 0.56, 0.63] as [number, number, number, number],
    };
    expect(tracker.update([faint], 100, "epoch", false)).toHaveLength(0);
  });

  it("reports frame-relative motion without ever implying a road speed", () => {
    const scenario = build({
      name: "rightward",
      purpose: "motion state",
      hz: 10,
      durationMs: 3000,
      objects: [
        linear({
          id: 1,
          from: [0.2, 0.6],
          to: [0.8, 0.6],
          size: [0.16, 0.13],
          startMs: 0,
          endMs: 3000,
        }),
      ],
      noise: { seed: 9, dropout: 0, jitter: 0.01, classFlip: 0 },
    });
    const tracker = new TimeAwareTrackerV2();
    let last = tracker.update([], 0, "epoch", false);
    for (const frame of scenario.frames)
      last = tracker.update(frame.detections, frame.sourceTimeMs + 1, "epoch", false);
    expect(last[0]!.motion).toBe("right");
  });
});
