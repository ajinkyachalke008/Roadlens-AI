import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  contentRect,
  OverlayModel,
  OVERLAY_LIMITS,
  overlayHealth,
  toContent,
} from "../../frontend/src/camera/overlay";
import {
  FRAME_RATE_CANDIDATES,
  frameRateNote,
  frameRateOptions,
} from "../../frontend/src/camera/frameRate";
import { frame as frameFixture } from "../contracts/fixtures";
import type { FrameResult } from "../../shared/src/schemas";

const analysed = (
  sourceTimeMs: number,
  boxes: { trackId: number; bbox: [number, number, number, number] }[],
  captureEpoch = "epoch-a",
): FrameResult => {
  const base = frameFixture(0);
  return {
    ...base,
    captureEpoch,
    frameSeq: Math.round(sourceTimeMs),
    frameId: `${captureEpoch}:${Math.round(sourceTimeMs)}`,
    sourceTimeMs,
    tracks: boxes.map((box) => ({
      trackId: box.trackId,
      className: "car" as const,
      score: 0.9,
      bbox: box.bbox,
      observed: true,
      speedMps: null,
      speedStatus: "unavailable" as const,
      speedReason: "not_calibrated" as const,
      ruleState: "unmeasured" as const,
    })),
  };
};

describe("overlay geometry", () => {
  it("maps normalized boxes into the letterboxed content rectangle", () => {
    // Portrait camera inside a wide box: bars left and right.
    const rect = contentRect(1000, 570, 720, 1280);
    expect(rect.height).toBeCloseTo(570, 6);
    expect(rect.width).toBeCloseTo((570 * 720) / 1280, 6);
    expect(rect.x).toBeCloseTo((1000 - rect.width) / 2, 6);
    expect(rect.y).toBeCloseTo(0, 6);
    const box = toContent([0, 0, 1, 1], rect);
    expect(box.x).toBeCloseTo(rect.x, 6);
    expect(box.width).toBeCloseTo(rect.width, 6);
    // A full-frame detection can never reach into the bars.
    expect(box.x).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThan(1000);
  });

  it.each([
    [720, 1280],
    [1280, 720],
    [1920, 1080],
    [1170, 2532],
    [828, 1792],
  ])("keeps aspect ratio for %ix%i sources", (width, height) => {
    for (const [cw, ch] of [
      [390, 560],
      [1000, 570],
      [844, 390],
    ]) {
      const rect = contentRect(cw, ch, width, height);
      expect(rect.width / rect.height).toBeCloseTo(width / height, 6);
      expect(rect.width).toBeLessThanOrEqual(cw + 1e-9);
      expect(rect.height).toBeLessThanOrEqual(ch + 1e-9);
      expect(rect.x).toBeGreaterThanOrEqual(-1e-9);
      expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
      // Centred, so both bars are equal.
      expect(cw - rect.width - 2 * rect.x).toBeCloseTo(0, 6);
      expect(ch - rect.height - 2 * rect.y).toBeCloseTo(0, 6);
    }
  });

  it("falls back to the container when a size is not known yet", () => {
    expect(contentRect(300, 200, 0, 0)).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });
    expect(contentRect(300, 200, NaN, 100)).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });
  });
});

describe("display-only overlay motion", () => {
  it("advances a moving box between analysed frames and caps the horizon", () => {
    const model = new OverlayModel();
    // 0.1 normalized units per 100 ms, left to right.
    model.update(analysed(0, [{ trackId: 1, bbox: [0.1, 0.4, 0.2, 0.5] }]));
    model.update(analysed(100, [{ trackId: 1, bbox: [0.2, 0.4, 0.3, 0.5] }]));
    const onTime = model.stateAt(100);
    expect(onTime.boxes[0]!.bbox[0]).toBeCloseTo(0.2, 6);
    expect(onTime.boxes[0]!.extrapolatedMs).toBe(0);
    const midway = model.stateAt(150);
    expect(midway.boxes[0]!.bbox[0]).toBeCloseTo(0.25, 6);
    expect(midway.boxes[0]!.extrapolatedMs).toBe(50);
    // Never advanced further than the documented display horizon.
    const capped = model.stateAt(100 + OVERLAY_LIMITS.staleMs);
    expect(capped.boxes[0]!.extrapolatedMs).toBe(
      OVERLAY_LIMITS.extrapolationMs,
    );
    expect(capped.boxes[0]!.bbox[0]).toBeCloseTo(
      0.2 + 0.001 * OVERLAY_LIMITS.extrapolationMs,
      6,
    );
  });

  it("tracks both directions of travel", () => {
    const model = new OverlayModel();
    model.update(analysed(0, [{ trackId: 7, bbox: [0.8, 0.4, 0.9, 0.5] }]));
    model.update(analysed(100, [{ trackId: 7, bbox: [0.6, 0.4, 0.7, 0.5] }]));
    const state = model.stateAt(200);
    expect(state.boxes[0]!.bbox[0]).toBeLessThan(0.6);
    expect(state.boxes[0]!.bbox[0]).toBeCloseTo(0.6 - 0.002 * 100, 6);
    expect(state.boxes[0]!.bbox[2] - state.boxes[0]!.bbox[0]).toBeCloseTo(
      0.1,
      6,
    );
  });

  it("freezes and fades a stale result instead of predicting onwards", () => {
    const model = new OverlayModel();
    model.update(analysed(0, [{ trackId: 1, bbox: [0.1, 0.4, 0.2, 0.5] }]));
    model.update(analysed(100, [{ trackId: 1, bbox: [0.2, 0.4, 0.3, 0.5] }]));
    const stale = model.stateAt(100 + OVERLAY_LIMITS.staleMs + 1);
    expect(stale.health).toBe("stale");
    expect(stale.boxes[0]!.extrapolatedMs).toBe(0);
    expect(stale.boxes[0]!.bbox[0]).toBeCloseTo(0.2, 6);
    expect(stale.boxes[0]!.opacity).toBeLessThan(1);
    const later = model.stateAt(
      100 + OVERLAY_LIMITS.staleMs + OVERLAY_LIMITS.fadeMs + 10,
    );
    expect(later.boxes[0]!.opacity).toBe(0);
    expect(later.boxes[0]!.bbox[0]).toBeCloseTo(0.2, 6);
  });

  it("holds a box longer when the measured analysis cadence is slower", () => {
    const fast = new OverlayModel();
    for (let i = 0; i <= 8; i++)
      fast.update(
        analysed(i * 100, [{ trackId: 1, bbox: [0.1, 0.4, 0.2, 0.5] }]),
      );
    // 10 Hz analysis: the documented floor already covers the gap.
    expect(fast.holdMs).toBe(OVERLAY_LIMITS.staleMs);
    const slow = new OverlayModel();
    for (let i = 0; i <= 8; i++)
      slow.update(
        analysed(i * 300, [{ trackId: 1, bbox: [0.1, 0.4, 0.2, 0.5] }]),
      );
    // 3.3 Hz analysis: a 350 ms old result is on time, not stale.
    expect(slow.holdMs).toBeCloseTo(300 * OVERLAY_LIMITS.staleFactor, 6);
    expect(slow.stateAt(2400 + 350).boxes[0]!.opacity).toBe(1);
    expect(fast.stateAt(800 + 350).boxes[0]!.opacity).toBeLessThan(1);
    // Still bounded: a stalled pipeline always fades.
    const stalled = new OverlayModel();
    for (let i = 0; i <= 8; i++)
      stalled.update(
        analysed(i * 2000, [{ trackId: 1, bbox: [0.1, 0.4, 0.2, 0.5] }]),
      );
    expect(stalled.holdMs).toBe(OVERLAY_LIMITS.maxStaleMs);
  });

  it("reports overlay health bands", () => {
    expect(overlayHealth(0)).toBe("healthy");
    expect(overlayHealth(99)).toBe("healthy");
    expect(overlayHealth(150)).toBe("degraded");
    expect(overlayHealth(OVERLAY_LIMITS.staleMs)).toBe("degraded");
    expect(overlayHealth(OVERLAY_LIMITS.staleMs + 1)).toBe("stale");
  });

  it("does not invent motion from a single observation or a new epoch", () => {
    const model = new OverlayModel();
    model.update(analysed(0, [{ trackId: 1, bbox: [0.1, 0.4, 0.2, 0.5] }]));
    expect(model.stateAt(100).boxes[0]!.bbox).toEqual([0.1, 0.4, 0.2, 0.5]);
    expect(model.stateAt(100).boxes[0]!.extrapolatedMs).toBe(0);
    model.update(analysed(50, [{ trackId: 1, bbox: [0.3, 0.4, 0.4, 0.5] }]));
    model.update(
      analysed(0, [{ trackId: 1, bbox: [0.5, 0.4, 0.6, 0.5] }], "epoch-b"),
    );
    // A source restart clears history: no velocity across the boundary.
    expect(model.stateAt(80).boxes[0]!.bbox).toEqual([0.5, 0.4, 0.6, 0.5]);
  });

  it("ignores out-of-order and repeated analysed frames", () => {
    const model = new OverlayModel();
    model.update(analysed(100, [{ trackId: 1, bbox: [0.2, 0.4, 0.3, 0.5] }]));
    model.update(analysed(60, [{ trackId: 1, bbox: [0.9, 0.4, 1, 0.5] }]));
    expect(model.result!.sourceTimeMs).toBe(100);
    expect(model.stateAt(100).boxes[0]!.bbox[0]).toBeCloseTo(0.2, 6);
    model.update(analysed(100, [{ trackId: 1, bbox: [0.9, 0.4, 1, 0.5] }]));
    expect(model.stateAt(100).boxes[0]!.bbox[0]).toBeCloseTo(0.2, 6);
  });

  it("drops history for tracks that are no longer observed", () => {
    const model = new OverlayModel();
    model.update(
      analysed(0, [
        { trackId: 1, bbox: [0.1, 0.4, 0.2, 0.5] },
        { trackId: 2, bbox: [0.5, 0.4, 0.6, 0.5] },
      ]),
    );
    model.update(analysed(100, [{ trackId: 1, bbox: [0.2, 0.4, 0.3, 0.5] }]));
    expect(model.stateAt(100).boxes).toHaveLength(1);
    model.reset();
    expect(model.stateAt(100).boxes).toHaveLength(0);
    expect(model.result).toBeNull();
  });

  it("keeps interpolation out of the measurement pipeline", () => {
    // Structural: nothing that measures may import the display overlay.
    const measurement = [
      "frontend/src/camera/capture.ts",
      "frontend/src/tracking/tracker.ts",
      "frontend/src/geometry/speed.ts",
      "frontend/src/geometry/calibration.ts",
      "frontend/src/rules/candidates.ts",
      "frontend/src/rules/counts.ts",
      "frontend/src/session/store.ts",
      "frontend/src/inference/remote.ts",
    ];
    for (const file of measurement)
      expect(readFileSync(file, "utf8")).not.toContain("camera/overlay");
    const overlay = readFileSync("frontend/src/camera/overlay.ts", "utf8");
    for (const forbidden of ["tracking/", "geometry/", "rules/", "session/"])
      expect(overlay).not.toContain(forbidden);
  });
});

describe("camera frame rate options", () => {
  it("offers only rates the track's capabilities admit", () => {
    expect(
      frameRateOptions({ frameRate: { min: 1, max: 60 } }, { frameRate: 30 }),
    ).toEqual([24, 30, 60]);
    expect(
      frameRateOptions({ frameRate: { min: 1, max: 120 } }, { frameRate: 60 }),
    ).toEqual([...FRAME_RATE_CANDIDATES]);
    expect(
      frameRateOptions({ frameRate: { min: 1, max: 30 } }, { frameRate: 30 }),
    ).toEqual([24, 30]);
    // 90 is offered only when the track really reports it.
    expect(
      frameRateOptions({ frameRate: { min: 30, max: 90 } }, { frameRate: 30 }),
    ).toEqual([30, 60, 90]);
  });

  it("stays conservative without capability information", () => {
    expect(frameRateOptions(null, { frameRate: 29.97 })).toEqual([30]);
    expect(frameRateOptions(undefined, undefined)).toEqual([]);
    expect(frameRateOptions({}, { frameRate: 0 })).toEqual([]);
    expect(frameRateOptions({ frameRate: {} }, { frameRate: 60 })).toEqual([
      60,
    ]);
  });

  it("includes a non-standard current rate and never exceeds the maximum", () => {
    expect(
      frameRateOptions({ frameRate: { max: 50 } }, { frameRate: 50 }),
    ).toEqual([24, 30, 50]);
    expect(
      frameRateOptions({ frameRate: { max: 30 } }, { frameRate: 120 }),
    ).toEqual([24, 30]);
  });

  it("never claims a rate the camera did not report", () => {
    expect(frameRateNote("auto", 59.94)).toBe("Automatic · 59.9 FPS");
    expect(frameRateNote(60, 60)).toBe("60.0 FPS");
    expect(frameRateNote(120, 30)).toBe(
      "Requested 120; camera selected 30.0 FPS",
    );
    expect(frameRateNote(120, null)).toBe("Actual rate unavailable");
  });
});
