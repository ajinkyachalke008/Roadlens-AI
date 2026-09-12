import { describe, expect, it } from "vitest";
import type { TrackView } from "../../shared/src/schemas";
import {
  frame as frameFixture,
  report as reportFixture,
} from "../contracts/fixtures";
import {
  evidenceAnnotation,
  evidenceGeometry,
} from "../../frontend/src/session/evidence";
import {
  isShowcaseReport,
  reportMeasurementMode,
  reportSpeedStatus,
} from "../../frontend/src/components/Reports";

const target = (overrides: Partial<TrackView> = {}): TrackView => ({
  trackId: 11,
  className: "car",
  score: 0.93,
  bbox: [0.2, 0.25, 0.58, 0.7],
  observed: true,
  speedMps: null,
  speedStatus: "unavailable",
  speedReason: "handheld",
  ruleState: "unmeasured",
  trackState: "confirmed",
  observedMs: 1_200,
  ...overrides,
});

describe("report-time evidence annotation", () => {
  it("locks annotation facts to the exact frame and exact observed track", () => {
    const frame = {
      ...frameFixture(7),
      tracks: [
        target({ trackId: 4, className: "truck", bbox: [0.05, 0.1, 0.2, 0.3] }),
        target(),
      ],
    };
    expect(evidenceAnnotation(frame, 11)).toEqual({
      frameId: frame.frameId,
      trackId: 11,
      className: "car",
      score: 0.93,
      bbox: [0.2, 0.25, 0.58, 0.7],
      style: "showcase",
    });
    expect(evidenceAnnotation(frame, 99)).toBeNull();
    expect(
      evidenceAnnotation(
        { ...frame, tracks: [target({ observed: false })] },
        11,
      ),
    ).toBeNull();
  });

  it("keeps the target stroke and label inside every image edge", () => {
    for (const bbox of [
      [0, 0, 0.22, 0.18],
      [0.78, 0, 1, 0.2],
      [0, 0.8, 0.25, 1],
      [0.8, 0.78, 1, 1],
    ] as const) {
      const geometry = evidenceGeometry(640, 360, bbox, 250, 58);
      expect(geometry).not.toBeNull();
      for (const rectangle of [geometry!.target, geometry!.label]) {
        expect(rectangle.x).toBeGreaterThanOrEqual(0);
        expect(rectangle.y).toBeGreaterThanOrEqual(0);
        expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(640);
        expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(360);
      }
    }
  });

  it("adds a bounded opposite-corner inset only when the target is small", () => {
    const small = evidenceGeometry(640, 360, [0.03, 0.04, 0.13, 0.18], 250, 58);
    expect(small?.inset).not.toBeNull();
    expect(small!.inset!.x).toBeGreaterThan(320);
    expect(small!.inset!.y).toBeGreaterThan(180);
    expect(small!.inset!.x + small!.inset!.width).toBeLessThanOrEqual(640);
    expect(small!.inset!.y + small!.inset!.height).toBeLessThanOrEqual(360);
    expect(
      evidenceGeometry(640, 360, [0.15, 0.12, 0.85, 0.88], 250, 58)?.inset,
    ).toBeNull();
  });
});

describe("professional report wording", () => {
  it("keeps Showcase explicit while presenting handheld speed professionally", () => {
    const report = {
      ...reportFixture(),
      policy: { ...reportFixture().policy, speedLimitMps: null },
      validityReasons: ["handheld", "showcase_trigger"],
    };
    expect(isShowcaseReport(report)).toBe(true);
    expect(reportMeasurementMode(report)).toBe("Handheld");
    expect(reportSpeedStatus(report)).toBe("Mounted calibration required");
  });

  it("preserves genuine qualified-speed wording", () => {
    const report = {
      ...reportFixture(),
      kind: "speed_candidate" as const,
      speedMps: 12,
      calibrationVersion: "calibration-v1",
      validityReasons: [],
    };
    expect(isShowcaseReport(report)).toBe(false);
    expect(reportMeasurementMode(report)).toBe("Mounted");
    expect(reportSpeedStatus(report)).toBe("Qualified measurement");
  });
});
