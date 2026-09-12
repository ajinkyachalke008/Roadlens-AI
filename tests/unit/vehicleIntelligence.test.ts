import { describe, expect, it } from "vitest";
import { hitTest, overlayLabel } from "../../frontend/src/components/Stage";
import { estimateSpeed } from "../../frontend/src/geometry/speed";
import type { TrackedObject } from "../../frontend/src/tracking/tracker";
import type { Calibration } from "../../frontend/src/geometry/calibration";

/**
 * The rules that decide what an operator is shown, kept honest.
 *
 * The one that matters most is negative: a handheld camera mixes its own motion
 * with the vehicle's, so it must produce no speed at all rather than a
 * confident-looking wrong one.
 */

const EPOCH = "11111111-1111-4111-8111-111111111111";

const calibration = (over: Partial<Calibration> = {}): Calibration =>
  ({
    version: "cal-1",
    captureEpoch: EPOCH,
    frameWidth: 1280,
    frameHeight: 720,
    stationaryConfirmed: true,
    zone: [
      [0.1, 0.4],
      [0.9, 0.4],
      [0.9, 0.95],
      [0.1, 0.95],
    ],
    // Scales normalised image coordinates to metres on the road plane, so the
    // estimator sees a real displacement rather than a fraction of a frame.
    H: [40, 0, 0, 0, 40, 0, 0, 0, 1],
    ...over,
  }) as Calibration;

/** A vehicle observed long enough and far enough to be measurable. */
const measurableTrack = (): TrackedObject => ({
  trackId: 12,
  className: "car",
  score: 0.94,
  bbox: [0.45, 0.6, 0.6, 0.72],
  observed: true,
  state: "confirmed",
  ambiguous: false,
  observations: Array.from({ length: 12 }, (_, i) => ({
    sourceTimeMs: i * 160,
    bbox: [0.2 + i * 0.02, 0.6, 0.35 + i * 0.02, 0.72] as [
      number,
      number,
      number,
      number,
    ],
  })),
});

describe("overlay label", () => {
  it("names the identity so a track number cannot read as a count", () => {
    expect(overlayLabel("car", 64, null, "mph")).toBe("CAR · ID 64");
    expect(overlayLabel("car", 64, null, "mph")).not.toContain("#");
  });
  it("adds speed only when the frame carries one", () => {
    expect(overlayLabel("car", 12, null, "mph")).toBe("CAR · ID 12");
    expect(overlayLabel("car", 12, 13.9, "mph")).toContain("31.1 mph");
  });
  it("shows the amount over the limit on a candidate", () => {
    const label = overlayLabel("car", 12, 21, "mph", 5.4);
    expect(label).toContain("47.0 mph");
    expect(label).toContain("+12.1 mph");
  });
  it("never labels a vehicle with a rate when speed is unavailable", () => {
    for (const unit of ["mph", "km/h"] as const)
      expect(overlayLabel("car", 3, null, unit)).not.toMatch(/mph|km\/h/);
    expect(overlayLabel("car", 3, null, "km/h")).toBe("CAR · ID 3");
  });
});

describe("tap selection", () => {
  const boxes = [
    {
      trackId: 1,
      className: "bus",
      bbox: [0.1, 0.1, 0.9, 0.9] as const,
      speedMps: null,
      ruleState: "normal",
    },
    {
      trackId: 2,
      className: "car",
      bbox: [0.4, 0.4, 0.6, 0.6] as const,
      speedMps: null,
      ruleState: "normal",
    },
  ];
  it("selects the vehicle under the tap", () => {
    expect(hitTest(boxes, [0.15, 0.15])).toBe(1);
  });
  it("prefers the smaller box when boxes overlap", () => {
    expect(hitTest(boxes, [0.5, 0.5])).toBe(2);
  });
  it("clears the selection when the tap misses every vehicle", () => {
    expect(hitTest(boxes, [0.95, 0.05])).toBeNull();
  });
});

describe("speed availability", () => {
  const context = {
    calibration: calibration(),
    captureEpoch: EPOCH,
    frameWidth: 1280,
    frameHeight: 720,
    mounted: true,
    background: "verified" as const,
  };

  it("produces a speed for a mounted, calibrated, stationary camera", () => {
    const estimate = estimateSpeed(measurableTrack(), context);
    expect(estimate.reason).toBeNull();
    expect(estimate.speedMps).toBeGreaterThan(0);
  });

  it("produces no speed at all while handheld", () => {
    const estimate = estimateSpeed(measurableTrack(), {
      ...context,
      mounted: false,
    });
    expect(estimate.speedMps).toBeNull();
    expect(estimate.reason).toBe("handheld");
  });

  it("withdraws speed the moment the camera is seen to move", () => {
    const estimate = estimateSpeed(measurableTrack(), {
      ...context,
      background: "camera_moved",
    });
    expect(estimate.speedMps).toBeNull();
    expect(estimate.reason).toBe("camera_moved");
  });

  it("withdraws speed while the background is unverified", () => {
    const estimate = estimateSpeed(measurableTrack(), {
      ...context,
      background: "background_unverified",
    });
    expect(estimate.speedMps).toBeNull();
  });

  it("refuses a calibration that was not confirmed stationary", () => {
    const estimate = estimateSpeed(measurableTrack(), {
      ...context,
      calibration: calibration({ stationaryConfirmed: false }),
    });
    expect(estimate.speedMps).toBeNull();
    expect(estimate.reason).toBe("calibration_invalid");
  });

  it("refuses a calibration captured in another epoch", () => {
    const estimate = estimateSpeed(measurableTrack(), {
      ...context,
      calibration: calibration({
        captureEpoch: "22222222-2222-4222-8222-222222222222",
      }),
    });
    expect(estimate.speedMps).toBeNull();
    expect(estimate.reason).toBe("calibration_invalid");
  });

  it("refuses an ambiguous track even when everything else is valid", () => {
    const estimate = estimateSpeed(
      { ...measurableTrack(), ambiguous: true },
      context,
    );
    expect(estimate.speedMps).toBeNull();
    expect(estimate.reason).toBe("track_ambiguous");
  });

  it("refuses a track that is not yet confirmed", () => {
    const estimate = estimateSpeed(
      { ...measurableTrack(), state: "tentative" },
      context,
    );
    expect(estimate.speedMps).toBeNull();
  });

  it("cannot be measured from a single noisy frame", () => {
    const track = measurableTrack();
    const estimate = estimateSpeed(
      { ...track, observations: track.observations.slice(-1) },
      context,
    );
    expect(estimate.speedMps).toBeNull();
    expect(estimate.reason).toBe("insufficient_samples");
  });
});
