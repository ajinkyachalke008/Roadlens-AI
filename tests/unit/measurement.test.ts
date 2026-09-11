import { describe, expect, it } from "vitest";
import {
  hungarian,
  iou,
  TimeAwareTracker,
  type Box,
  type Detection,
  type TrackedObject,
} from "../../frontend/src/tracking/tracker";
import {
  calibrationQuality,
  createCalibration,
  insidePolygon,
  project,
  solveHomography,
  validPolygon,
  type CalibrationInput,
  type Point,
} from "../../frontend/src/geometry/calibration";
import {
  estimateSpeed,
  toKmh,
  toMph,
  type SpeedContext,
} from "../../frontend/src/geometry/speed";
import { BackgroundGuard } from "../../frontend/src/geometry/background";
import { CandidateRules } from "../../frontend/src/rules/candidates";
import {
  countObserved,
  DirectedCounter,
} from "../../frontend/src/rules/counts";

const detection = (x = 0.2, score = 0.9): Detection => ({
  className: "car",
  score,
  bbox: [x, 0.2, x + 0.1, 0.3],
});
const setup = (): CalibrationInput => ({
  pairs: [
    { image: [0, 0], world: [0, 0] },
    { image: [1, 0], world: [100, 0] },
    { image: [1, 1], world: [100, 100] },
    { image: [0, 1], world: [0, 100] },
  ],
  check: { image: [0.5, 0.5], world: [50, 50], checkedLengthM: 100 },
  zone: [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ],
  frameWidth: 1280,
  frameHeight: 720,
  captureEpoch: "test-epoch",
  stationaryConfirmed: true,
});
const context = (): SpeedContext => ({
  calibration: createCalibration(setup()),
  frameWidth: 1280,
  frameHeight: 720,
  captureEpoch: "test-epoch",
  mounted: true,
  background: "verified",
});
function motion(
  times = Array.from({ length: 11 }, (_, i) => i * 200),
  speed = 10,
): TrackedObject {
  const observations = times.map((sourceTimeMs) => {
    const x = 0.2 + (speed * sourceTimeMs) / 100000;
    return { sourceTimeMs, bbox: [x - 0.025, 0.1, x + 0.025, 0.2] as Box };
  });
  return {
    ...detection(),
    bbox: observations.at(-1)!.bbox,
    observations,
    trackId: 1,
    observed: true,
    state: "confirmed",
    ambiguous: false,
  };
}
describe("B20 time_aware_iou_v1 (synthetic association tests)", () => {
  it("never includes an unverified current frame in a later qualified speed window", () => {
    const tracker = new TimeAwareTracker();
    const at = (time: number): Detection => ({
      className: "car", score: 0.9,
      bbox: [0.1 + time / 10000, 0.1, 0.2 + time / 10000, 0.2],
    });
    for (let time = 0; time <= 500; time += 250)
      tracker.update([at(time)], time, "test-epoch");
    let track = tracker.update([at(750)], 750, "test-epoch", false)[0]!;
    expect(track.observed).toBe(true);
    expect(track.state).toBe("confirmed");
    expect(track.observations).toEqual([]);
    for (let time = 1000; time <= 2500; time += 250)
      track = tracker.update([at(time)], time, "test-epoch", true)[0]!;
    expect(track.observations).toHaveLength(7);
    expect(estimateSpeed(track, context())).toMatchObject({ speedMps: null, reason: "insufficient_samples" });
    track = tracker.update([at(2750)], 2750, "test-epoch", true)[0]!;
    expect(track.observations[0]!.sourceTimeMs).toBe(1000);
    expect(estimateSpeed(track, context()).speedMps).toBeCloseTo(10);
  });
  it("keeps low-confidence recovery during unqualified measurement and never records those positions", () => {
    const tracker = new TimeAwareTracker();
    for (let i = 0; i < 3; i++) tracker.update([detection()], i * 200, "a", false);
    const track = tracker.update([detection(0.2, 0.2)], 600, "a", false)[0]!;
    expect(track).toMatchObject({ trackId: 1, observed: true, state: "confirmed" });
    expect(track.observations).toEqual([]);
  });
  it("prioritizes new observed detections over lost tracks when the cap is full", () => {
    const tracker = new TimeAwareTracker();
    tracker.update(Array.from({ length: 100 }, () => detection()), 0, "a");
    const tracks = tracker.update([{ className: "bus", score: 0.99, bbox: [0.6, 0.6, 0.8, 0.8] }], 250, "a");
    expect(tracks).toHaveLength(100);
    expect(tracks.filter(t => t.observed)).toMatchObject([{ trackId: 101, className: "bus" }]);
    expect(countObserved(tracks).bus).toBe(1);
    expect(countObserved(tracks).car).toBe(0);
  });
  it("Hungarian resolves globally optimal competition and rejects gated rows", () => {
    expect(
      hungarian([
        [0.1, 0.2],
        [0.11, 0.8],
      ]),
    ).toEqual([1, 0]);
    expect(hungarian([[1e6], [0.1]])).toEqual([-1, 0]);
    expect(hungarian([[], []])).toEqual([-1, -1]);
  });
  it("Hungarian handles rectangular matrices and empty inputs", () => {
    expect(hungarian([])).toEqual([]);
    expect(hungarian([[0.8, 0.2, 0.1]])).toEqual([2]);
  });
  it("IoU handles overlap and disjoint boxes", () => {
    expect(iou([0, 0, 1, 1], [0, 0, 1, 1])).toBe(1);
    expect(iou([0, 0, 0.2, 0.2], [0.8, 0.8, 1, 1])).toBe(0);
  });
  it("keeps identity through variable timing and lower-confidence recovery", () => {
    const tracker = new TimeAwareTracker();
    const first = tracker.update([detection()], 0, "a")[0]!;
    tracker.update([detection(0.205)], 120, "a");
    tracker.update([detection(0.212)], 300, "a");
    const fourth = tracker.update([detection(0.22, 0.2)], 500, "a")[0]!;
    expect(fourth.trackId).toBe(first.trackId);
    expect(fourth.state).toBe("confirmed");
    expect(fourth.observations).toHaveLength(4);
  });
  it("does not create tracks from low confidence alone", () => {
    expect(
      new TimeAwareTracker().update([detection(0.2, 0.2)], 0, "a"),
    ).toEqual([]);
  });
  it("invalidates history after missed observation and recovery", () => {
    const tracker = new TimeAwareTracker();
    for (let i = 0; i < 5; i++) tracker.update([detection()], i * 100, "a");
    expect(tracker.update([], 500, "a")[0]!.observations).toEqual([]);
    const recovered = tracker.update([detection()], 600, "a")[0]!;
    expect(recovered.trackId).toBe(1);
    expect(recovered.observations).toHaveLength(1);
  });
  it("marks competing assignments ambiguous and clears observations", () => {
    const tracker = new TimeAwareTracker();
    tracker.update([detection(0.2), detection(0.205)], 0, "a");
    const tracks = tracker.update([detection(0.202)], 200, "a");
    expect(tracks.find((t) => t.observed)!.ambiguous).toBe(true);
    expect(tracks.find((t) => t.observed)!.observations).toHaveLength(0);
  });
  it("binds IDs to epochs and never recycles after time discontinuity within an epoch", () => {
    const tracker = new TimeAwareTracker();
    tracker.update([detection()], 100, "a");
    expect(tracker.update([detection()], 90, "a")).toEqual([]);
    expect(tracker.update([detection()], 200, "a")[0]!.trackId).toBe(2);
    expect(tracker.update([detection()], 0, "b")[0]!.trackId).toBe(1);
  });
  it("expires lost tracks by time and caps observation history", () => {
    const tracker = new TimeAwareTracker();
    for (let i = 0; i < 100; i++) tracker.update([detection()], i * 100, "a");
    expect(
      tracker.update([detection()], 10000, "a")[0]!.observations,
    ).toHaveLength(32);
    expect(tracker.update([], 12000, "a")).toEqual([]);
  });
  it("rejects invalid detections and caps tracks at 100", () => {
    const tracker = new TimeAwareTracker();
    expect(
      tracker.update([{ ...detection(), bbox: [NaN, 0, 1, 1] }], 0, "a"),
    ).toEqual([]);
    expect(
      tracker.update(
        Array.from({ length: 150 }, () => detection()),
        200,
        "a",
      ),
    ).toHaveLength(100);
  });
  it("does not mutate a prior returned snapshot or silently switch semantic classes", () => {
    const tracker = new TimeAwareTracker();
    const prior = tracker.update([detection()], 0, "a");
    const next = tracker.update(
      [{ ...detection(), className: "bus" }],
      100,
      "a",
    );
    expect(prior[0]!.observed).toBe(true);
    expect(next.find((t) => t.trackId === 1)!.className).toBe("car");
    expect(next.find((t) => t.observed)!.trackId).toBe(2);
  });
  it("recalibration invalidates measurements while preserving current and next IDs", () => {
    const tracker = new TimeAwareTracker();
    for (let i = 0; i < 10; i++) tracker.update([detection()], i * 200, "a");
    tracker.invalidateMeasurements();
    const tracks = tracker.update([detection(), detection(0.7)], 2000, "a");
    expect(tracks[0]!.trackId).toBe(1);
    expect(tracks[0]!.observations).toHaveLength(1);
    expect(tracks[0]!.state).toBe("tentative");
    expect(tracks[1]!.trackId).toBe(2);
  });
});
describe("B30 normalized DLT and independent calibration (synthetic geometry)", () => {
  it("fits metric identity scale with an independent fifth point", () => {
    const c = createCalibration(setup());
    expect(project(c.H, [0.3, 0.7])![0]).toBeCloseTo(30, 7);
    expect(c.independentErrorM).toBeLessThan(1e-8);
  });
  it("fits a known perspective mapping", () => {
    const H = [20, 2, 3, 1, 30, 4, 0.2, 0.1, 1];
    const pairs = setup().pairs.map((p) => ({
      image: p.image,
      world: project(H, p.image)!,
    }));
    const result = project(solveHomography(pairs), [0.43, 0.57])!;
    expect(result[0]).toBeCloseTo(project(H, [0.43, 0.57])![0], 7);
    expect(result[1]).toBeCloseTo(project(H, [0.43, 0.57])![1], 7);
  });
  it("rejects rank-deficient and coincident fits", () => {
    expect(() =>
      solveHomography(
        [0, 1, 2, 3].map((x) => ({ image: [x, x], world: [x * 2, x * 2] })),
      ),
    ).toThrow(/calibration_invalid/);
    expect(() =>
      solveHomography(Array(4).fill({ image: [0, 0], world: [0, 0] })),
    ).toThrow();
  });
  it("rejects self-intersecting ROI and accepts inside/boundary points", () => {
    expect(
      validPolygon([
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
      ]),
    ).toBe(false);
    expect(insidePolygon([0.5, 0.5], setup().zone)).toBe(true);
    expect(insidePolygon([0, 0.5], setup().zone)).toBe(true);
    expect(insidePolygon([1.1, 0.5], setup().zone)).toBe(false);
  });
  it("requires independent check distinct from fit and valid measured error", () => {
    const a = setup();
    a.check.image = [0, 0];
    expect(() => createCalibration(a)).toThrow(/fitted point/);
    const b = setup();
    b.check.world = [80, 80];
    expect(() => createCalibration(b)).toThrow(/independent check failed/);
  });
  it("rejects nonfinite/horizon projection, handheld and invalid geometry", () => {
    expect(project([1, 0, 0, 0, 1, 0, 0, 1, -0.5], [0.2, 0.5])).toBeNull();
    expect(project([NaN], [0, 0])).toBeNull();
    expect(() =>
      createCalibration({ ...setup(), stationaryConfirmed: false }),
    ).toThrow("handheld");
    expect(() => createCalibration({ ...setup(), frameWidth: 0 })).toThrow();
  });
  it("clones setup facts to keep older calibration provenance unchanged", () => {
    const a = setup(),
      c = createCalibration(a);
    a.pairs[0]!.world[0] = 999;
    expect(c.pairs[0]!.world[0]).toBe(0);
  });
  it("rejects finite but overflowing coordinates before entering numerical decomposition", () => {
    const pairs = setup().pairs.map((p) => ({
      image: p.image,
      world: [p.world[0] ? 1e308 : -1e308, p.world[1] ? 1e308 : -1e308] as [
        number,
        number,
      ],
    }));
    expect(() => solveHomography(pairs)).toThrow(/numeric scale/);
  });
  it("rejects an ROI straddling a perspective horizon even with a passing check point", () => {
    const H = [1, 0, 0, 0, 1, 0, 0, 1, -0.5],
      input = setup();
    input.pairs = input.pairs.map((p) => ({
      image: p.image,
      world: project(H, p.image)!,
    }));
    input.check = {
      image: [0.3, 0.3],
      world: project(H, [0.3, 0.3])!,
      checkedLengthM: 10,
    };
    expect(() => createCalibration(input)).toThrow(/horizon/);
  });
});
describe("B31 conservative textured background guard (synthetic pixels)", () => {
  const texture = () => {
    let seed = 123;
    return Uint8Array.from({ length: 160 * 120 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return seed >>> 24;
    });
  };
  it("requires a later unchanged textured comparison", () => {
    const g = new BackgroundGuard(),
      gray = texture();
    expect(g.capture(gray, 160, 120)).toBe("background_unverified");
    expect(g.check(gray, 160, 120)).toBe("verified");
  });
  it("poor texture and occluded background remain unverified", () => {
    const g = new BackgroundGuard(),
      flat = new Uint8Array(160 * 120).fill(100);
    g.capture(flat, 160, 120);
    expect(g.check(flat, 160, 120)).toBe("background_unverified");
    const gray = texture();
    g.capture(gray, 160, 120);
    expect(g.check(gray, 160, 120, [[0, 0, 1, 1]])).toBe(
      "background_unverified",
    );
  });
  it("latches movement or resolution change until fresh reference", () => {
    const g = new BackgroundGuard(),
      gray = texture(),
      moved = new Uint8Array(gray.length);
    for (let y = 0; y < 120; y++)
      for (let x = 1; x < 160; x++) moved[y * 160 + x] = gray[y * 160 + x - 1]!;
    g.capture(gray, 160, 120);
    expect(g.check(moved, 160, 120)).toBe("camera_moved");
    expect(g.check(gray, 160, 120)).toBe("camera_moved");
    g.capture(gray, 160, 120);
    expect(g.check(gray, 120, 160)).toBe("camera_moved");
  });
});
describe("B32–B33 robust source-time speed (synthetic, no field accuracy claim)", () => {
  it("recovers metric speed using uneven actual source timestamps", () => {
    const track = motion([
      0, 170, 410, 590, 810, 1000, 1210, 1390, 1610, 1800, 2010,
    ]);
    const s = estimateSpeed(track, context());
    expect(s.speedMps).toBeCloseTo(10, 6);
    expect(s.trajectory.length).toBeLessThanOrEqual(8);
    expect(toKmh(s.speedMps!)).toBeCloseTo(36);
    expect(toMph(10)).toBeCloseTo(22.369362921);
  });
  it.each([
    "handheld",
    "not_calibrated",
    "camera_moved",
    "background_unverified",
    "paused",
    "calibration_invalid",
  ] as const)("fails closed for %s", (reason) => {
    const c = context();
    if (reason === "handheld") c.mounted = false;
    if (reason === "not_calibrated") c.calibration = null;
    if (reason === "camera_moved" || reason === "background_unverified")
      c.background = reason;
    if (reason === "paused") c.paused = true;
    if (reason === "calibration_invalid") c.captureEpoch = "changed";
    expect(estimateSpeed(motion(), c)).toMatchObject({
      speedMps: null,
      reason,
    });
  });
  it("rejects ambiguous, tentative and predicted tracks immediately", () => {
    const t = motion();
    expect(
      estimateSpeed({ ...t, ambiguous: true }, context()).speedMps,
    ).toBeNull();
    expect(
      estimateSpeed({ ...t, observed: false }, context()).speedMps,
    ).toBeNull();
    expect(
      estimateSpeed({ ...t, state: "tentative" }, context()).speedMps,
    ).toBeNull();
  });
  it("rejects sparse samples, short coverage and gaps", () => {
    expect(
      estimateSpeed(
        motion(Array.from({ length: 9 }, (_, i) => i * 300)),
        context(),
      ).reason,
    ).toBe("sampling_too_sparse");
    expect(
      estimateSpeed(motion([0, 100, 200, 300, 400, 500, 600, 700]), context())
        .reason,
    ).toBe("insufficient_samples");
    expect(
      estimateSpeed(
        motion([0, 100, 200, 300, 400, 1000, 1100, 1200, 1300, 1500]),
        context(),
      ).reason,
    ).toBe("sampling_too_sparse");
  });
  it("rejects insufficient displacement, outside zone and time reversal", () => {
    expect(estimateSpeed(motion(undefined, 0), context()).reason).toBe(
      "insufficient_displacement",
    );
    const t = motion();
    t.bbox = [1.1, 0, 1.2, 0.2];
    expect(estimateSpeed(t, context()).reason).toBe("outside_zone");
    const reversed = motion();
    reversed.observations[5]!.sourceTimeMs = 1;
    expect(estimateSpeed(reversed, context()).reason).toBe(
      "time_discontinuity",
    );
  });
  it("rejects excessive measurement residual instead of clamping", () => {
    const t = motion();
    t.observations[5]!.bbox = [0.75, 0.1, 0.8, 0.2];
    expect(estimateSpeed(t, context()).reason).toBe("residual_too_high");
  });
  it("retains the movement explanation after the caller clears its invalid calibration", () => {
    expect(
      estimateSpeed(motion(), {
        ...context(),
        calibration: null,
        background: "camera_moved",
      }).reason,
    ).toBe("camera_moved");
  });
  it("requires a full new valid trajectory after an excursion outside the measurement zone", () => {
    const c = context();
    c.calibration!.zone = [
      [0.1, 0.1],
      [0.5, 0.1],
      [0.5, 0.5],
      [0.1, 0.5],
    ];
    const t = motion();
    t.observations[7]!.bbox = [0.7, 0.1, 0.8, 0.2];
    expect(estimateSpeed(t, c).reason).toBe("insufficient_samples");
  });
});
describe("B34 persistence, hysteresis and episode dedup", () => {
  const policy = { version: "p1", speedLimitMps: 10, demoMarginMps: 2 };
  it("one-frame spike does not produce a candidate", () => {
    const r = new CandidateRules();
    expect(r.update(1, "a", 0, 13, policy).episodeKey).toBeNull();
    expect(r.update(1, "a", 200, 9, policy).ruleState).toBe("normal");
  });
  it("requires at least 1 s persistence, emits once and ignores duplicate timestamps", () => {
    const r = new CandidateRules();
    const results = Array.from({ length: 11 }, (_, i) =>
      r.update(1, "a", i * 200, 13, policy),
    );
    expect(results.filter((x) => x.episodeKey)).toHaveLength(1);
    expect(results[5]!.episodeKey).toBe("a:1:speed_candidate:p1:0");
    expect(r.update(1, "a", 2000, 13, policy).episodeKey).toBeNull();
  });
  it("invalidity resets persistence and never retriggers emitted episode", () => {
    const r = new CandidateRules();
    for (let i = 0; i < 5; i++) r.update(1, "a", i * 200, 13, policy);
    expect(r.update(1, "a", 1000, null, policy).ruleState).toBe("unmeasured");
    expect(r.update(1, "a", 1200, 13, policy).episodeKey).toBeNull();
    for (let i = 7; i <= 11; i++) r.update(1, "a", i * 200, 13, policy);
    r.update(1, "a", 2400, null, policy);
    expect(r.update(1, "a", 2600, 13, policy).episodeKey).toBeNull();
  });
  it("gapped estimates cannot persist and demo margin is distinct from limit", () => {
    const r = new CandidateRules();
    expect(r.update(1, "a", 0, 11, policy).ruleState).toBe("above_limit");
    expect(r.update(1, "a", 1000, 13, policy).ruleState).toBe("unmeasured");
    expect(r.update(1, "a", 2000, 13, policy).episodeKey).toBeNull();
  });
  it("sustained hysteresis clearance allows a new episode", () => {
    const r = new CandidateRules();
    for (let i = 0; i <= 5; i++) r.update(1, "a", i * 200, 13, policy);
    for (let t = 1200; t <= 3400; t += 200) r.update(1, "a", t, 9, policy);
    const events = [];
    for (let t = 3600; t <= 4800; t += 200)
      events.push(r.update(1, "a", t, 13, policy));
    expect(events.find((e) => e.episodeKey)!.episodeKey).toBe(
      "a:1:speed_candidate:p1:1",
    );
  });
  it("recalibration clears pending persistence without forgetting emitted episodes", () => {
    const r = new CandidateRules();
    for (let i = 0; i <= 5; i++) r.update(1, "a", i * 200, 13, policy);
    r.invalidateContinuity();
    const events = [];
    for (let t = 1200; t <= 2400; t += 200)
      events.push(r.update(1, "a", t, 13, policy));
    expect(events.every((e) => e.episodeKey === null)).toBe(true);
  });
  it("a temporarily invalid policy also breaks pending persistence", () => {
    const r = new CandidateRules();
    for (let i = 0; i < 5; i++) r.update(1, "a", i * 200, 13, policy);
    r.update(1, "a", 900, 13, { ...policy, speedLimitMps: null });
    expect(r.update(1, "a", 1000, 13, policy).episodeKey).toBeNull();
  });
});
describe("B21 current presence and directed finite-line crossings", () => {
  const line = {
    a: [0.2, 0.5] as [number, number],
    b: [0.8, 0.5] as [number, number],
  };
  const at = (x: number, y: number) => ({
    ...motion(),
    bbox: [x - 0.05, y - 0.1, x + 0.05, y] as Box,
  });
  it("counts current observed objects only", () => {
    expect(
      countObserved([motion(), { ...motion(), observed: false }]).car,
    ).toBe(1);
  });
  it("counts one crossing per composite identity with hysteresis", () => {
    const c = new DirectedCounter();
    c.update([at(0.5, 0.4)], "a", line);
    expect(c.update([at(0.5, 0.501)], "a", line).forward).toBe(0);
    expect(c.update([at(0.5, 0.6)], "a", line).forward).toBe(1);
    expect(c.update([at(0.5, 0.4)], "a", line)).toEqual({
      forward: 1,
      reverse: 0,
    });
    expect(c.update([at(0.5, 0.6)], "b", line)).toEqual({
      forward: 0,
      reverse: 0,
    });
  });
  it("does not count crossing an extension or an occlusion gap", () => {
    const c = new DirectedCounter();
    c.update([at(0.1, 0.4)], "a", line);
    expect(c.update([at(0.1, 0.6)], "a", line).forward).toBe(0);
    c.reset();
    c.update([at(0.5, 0.4)], "a", line);
    c.update([{ ...at(0.5, 0.5), observed: false }], "a", line);
    expect(c.update([at(0.5, 0.6)], "a", line).forward).toBe(0);
  });
  it("does not bridge an entirely missing track between observations", () => {
    const c = new DirectedCounter();
    c.update([at(0.5, 0.4)], "a", line);
    c.update([], "a", line);
    expect(c.update([at(0.5, 0.6)], "a", line).forward).toBe(0);
  });
});

describe("calibration quality grading", () => {
  // A real planar homography: world coordinates are produced from the image
  // points through H, so the correspondences are exactly consistent and any
  // residual in a test comes from a deliberate perturbation.
  const H = [12, 0.4, -3.2, 0.6, 9.5, -4.1, 0.02, -0.9, 1];
  const imagePoints: Point[] = [
    [0.2, 0.8],
    [0.8, 0.8],
    [0.78, 0.55],
    [0.22, 0.55],
    [0.5, 0.66],
  ];
  const checkImage: Point = [0.5, 0.8];
  const worldOf = (image: Point) => {
    const world = project(H, image);
    if (!world) throw new Error("test homography degenerate");
    return world;
  };
  const base = (): CalibrationInput => ({
    pairs: imagePoints.map((image) => ({ image, world: worldOf(image) })),
    check: {
      image: checkImage,
      world: worldOf(checkImage),
      checkedLengthM: 10,
    },
    zone: [
      [0.21, 0.79],
      [0.79, 0.79],
      [0.77, 0.56],
      [0.23, 0.56],
    ],
    frameWidth: 1280,
    frameHeight: 720,
    captureEpoch: "epoch",
    stationaryConfirmed: true,
  });
  it("grades a comfortable five-point calibration valid", () => {
    const quality = calibrationQuality(createCalibration(base()));
    expect(quality.grade).toBe("valid");
    expect(quality.reasons).toEqual([]);
    expect(quality.worstMargin).toBeLessThan(0.6);
  });
  it("judges an exactly-determined fit by its independent check alone", () => {
    const input = base();
    input.pairs = input.pairs.slice(0, 4);
    const calibration = createCalibration(input);
    // Four points fit exactly, so the residual is structurally zero and must
    // not contribute to the grade in either direction.
    expect(calibration.fitResidualM).toBeLessThan(1e-6);
    const quality = calibrationQuality(calibration);
    expect(quality.grade).toBe("valid");
    expect(quality.worstMargin).toBeCloseTo(
      calibration.independentErrorM / 0.5,
      6,
    );
  });
  it("grades a four-point fit weak when its independent check is marginal", () => {
    const input = base();
    input.pairs = input.pairs.slice(0, 4);
    const exact = input.check.world;
    // Mis-measure the check by 0.4 m: inside the 0.5 m gate, past 60% of it.
    input.check = { ...input.check, world: [exact[0] + 0.4, exact[1]] };
    const quality = calibrationQuality(createCalibration(input));
    expect(quality.grade).toBe("weak");
    expect(quality.reasons.join(" ")).toContain("independent check");
    expect(quality.worstMargin).toBeGreaterThan(0.6);
  });
  it("names the marginal property when a gate is nearly exhausted", () => {
    const input = base();
    const exact = input.pairs[4]!.world;
    // Mis-measure one world point by 0.35 m: inside the 0.5 m gate, past 60%.
    input.pairs[4] = {
      image: input.pairs[4]!.image,
      world: [exact[0] + 0.35, exact[1]],
    };
    const quality = calibrationQuality(createCalibration(input));
    expect(quality.grade).toBe("weak");
    expect(quality.reasons.join(" ")).toMatch(/fit residual|independent check/);
    expect(quality.worstMargin).toBeGreaterThan(0.6);
  });
});
