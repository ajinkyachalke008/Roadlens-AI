import { describe, expect, it } from "vitest";
import {
  calculateBoxOverlap,
  isPersonOnMotorcycle,
  evaluateHelmetPresence,
  analyzeTwoWheelerViolations,
} from "../../frontend/src/violations/twoWheelerAnalyzer";
import type { Detection, Track } from "../../shared/src/schemas";

describe("Indian Two-Wheeler Violations Analyzer (MV Act 2019)", () => {
  it("computes bounding box IoU accurately", () => {
    // 50% overlap box
    const boxA: [number, number, number, number] = [0.1, 0.1, 0.5, 0.5];
    const boxB: [number, number, number, number] = [0.1, 0.1, 0.5, 0.5];
    expect(calculateBoxOverlap(boxA, boxB)).toBeCloseTo(1.0);

    const nonOverlapping: [number, number, number, number] = [0.6, 0.6, 0.9, 0.9];
    expect(calculateBoxOverlap(boxA, nonOverlapping)).toBe(0);
  });

  it("determines when a person detection is seated on a motorcycle", () => {
    // Motorcycle: [ymin: 0.3, xmin: 0.2, ymax: 0.8, xmax: 0.6]
    const motorcycle: [number, number, number, number] = [0.3, 0.2, 0.8, 0.6];

    // Rider seated upright in upper-middle region
    const rider: [number, number, number, number] = [0.25, 0.3, 0.65, 0.5];
    expect(isPersonOnMotorcycle(rider, motorcycle)).toBe(true);

    // Pedestrian walking on sidewalk far away
    const pedestrian: [number, number, number, number] = [0.25, 0.8, 0.65, 0.95];
    expect(isPersonOnMotorcycle(pedestrian, motorcycle)).toBe(false);
  });

  it("evaluates helmet presence based on contrast sample or aspect ratio", () => {
    const motorcycleBox: [number, number, number, number] = [0.2, 0.3, 0.7, 0.6];

    // Explicit high contrast cap sample (helmet detected)
    const withHelmet = evaluateHelmetPresence(motorcycleBox, { hasHighContrastCap: true });
    expect(withHelmet.isHelmet).toBe(true);

    // Explicit no contrast cap sample (no helmet)
    const withoutHelmet = evaluateHelmetPresence(motorcycleBox, { hasHighContrastCap: false });
    expect(withoutHelmet.isHelmet).toBe(false);

    // Normal ratio (height: 0.5, width: 0.35 -> ratio 1.42 -> standard helmet contour)
    const standardRider = evaluateHelmetPresence([0.2, 0.3, 0.7, 0.65]);
    expect(standardRider.isHelmet).toBe(true);
  });

  it("ignores non-motorcycle vehicle tracks", () => {
    const carTrack: Track = {
      trackId: 10,
      className: "car",
      bbox: [0.2, 0.2, 0.6, 0.6],
      score: 0.95,
      speedMps: 15.0,
      observed: true,
      stationary: false,
    } as unknown as Track;

    const result = analyzeTwoWheelerViolations(carTrack);
    expect(result.isTwoWheeler).toBe(false);
    expect(result.isTripleRiding).toBe(false);
    expect(result.violations).toHaveLength(0);
    expect(result.totalFineInr).toBe(0);
  });

  it("detects Triple-Riding when 3 co-located person detections are riding a motorcycle", () => {
    const motorcycleTrack: Track = {
      trackId: 21,
      className: "motorcycle",
      bbox: [0.3, 0.2, 0.8, 0.6],
      score: 0.92,
      speedMps: 12.0,
      observed: true,
      stationary: false,
    } as unknown as Track;

    // 3 persons overlapping the motorcycle
    const riders: Detection[] = [
      { className: "person", score: 0.89, bbox: [0.25, 0.25, 0.6, 0.4] }, // Driver
      { className: "person", score: 0.87, bbox: [0.27, 0.35, 0.62, 0.5] }, // Middle passenger
      { className: "person", score: 0.85, bbox: [0.29, 0.42, 0.64, 0.55] }, // Pillion passenger
    ] as Detection[];

    const result = analyzeTwoWheelerViolations(motorcycleTrack, riders);
    expect(result.isTwoWheeler).toBe(true);
    expect(result.estimatedRiderCount).toBe(3);
    expect(result.isTripleRiding).toBe(true);

    const tripleViolation = result.violations.find((v) => v.type === "triple_riding");
    expect(tripleViolation).toBeDefined();
    expect(tripleViolation?.section).toContain("Section 194C");
    expect(tripleViolation?.penaltyInr).toBe(1000);
  });

  it("detects No-Helmet violation under Section 194D and tallies combined penalties", () => {
    const motorcycleTrack: Track = {
      trackId: 22,
      className: "motorcycle",
      bbox: [0.3, 0.2, 0.8, 0.7], // Wider box -> aspect ratio 0.5/0.5 = 1.0 (fails 1.25-1.55 helmet ratio)
      score: 0.9,
      speedMps: 14.0,
      observed: true,
      stationary: false,
    } as unknown as Track;

    const result = analyzeTwoWheelerViolations(
      motorcycleTrack,
      [],
      { hasHighContrastCap: false }, // Explicit unhelmeted rider
    );

    expect(result.hasNoHelmetViolation).toBe(true);
    const helmetViolation = result.violations.find((v) => v.type === "no_helmet");
    expect(helmetViolation).toBeDefined();
    expect(helmetViolation?.section).toContain("Section 194D");
    expect(helmetViolation?.penaltyInr).toBe(1000);
    expect(result.totalFineInr).toBeGreaterThanOrEqual(1000);
  });

  it("detects Triple-Riding via wide aspect ratio occupancy heuristic when person detections are fused", () => {
    // In dense traffic, YOLO often detects the motorcycle + 3 riders as a single wide motorcycle box
    const wideTripleTrack: Track = {
      trackId: 23,
      className: "motorcycle",
      bbox: [0.3, 0.1, 0.7, 0.6], // height 0.4, width 0.5 -> aspectRatio 1.25 (> 1.05)
      score: 0.91,
      speedMps: 11.0,
      observed: true,
      stationary: false,
    } as unknown as Track;

    const result = analyzeTwoWheelerViolations(wideTripleTrack, []);
    expect(result.isTripleRiding).toBe(true);
    expect(result.estimatedRiderCount).toBe(3);
    expect(result.violations.some((v) => v.type === "triple_riding")).toBe(true);
  });
});
