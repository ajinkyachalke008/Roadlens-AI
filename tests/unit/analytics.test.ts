import { describe, expect, it } from "vitest";
import {
  computeTrafficAnalytics,
  generateAnalyticsCsv,
} from "../../frontend/src/analytics/trafficAnalytics";
import type { Report } from "../../shared/src/schemas";

function createMockReport(overrides: Partial<Report>): Report {
  return {
    reportId: `rep-${Math.random().toString(36).slice(2)}`,
    revision: 1,
    sourceId: "source-1",
    captureEpoch: "epoch-1",
    frameId: "f-01",
    trackId: 1,
    sourceMode: "live_camera",
    sourceTimeMs: 1000,
    capturedAtIso: new Date().toISOString(),
    kind: "observation",
    className: "car",
    score: 0.9,
    speedMps: null,
    policy: {
      version: "p-1",
      roadLabel: "Main Road",
      speedLimitMps: 13.88, // 50 km/h
      demoMarginMps: 1.38,
      limitSource: "operator_entered_demo",
    },
    calibrationVersion: "cal-1",
    modelId: "yolo26n",
    modelSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    detectorProfile: "profile-1",
    trackerVersion: "track-1",
    validityReasons: [],
    evidenceSummary: {
      trajectory: [],
      residualM: null,
      coverageMs: null,
    },
    review: "pending",
    evidenceState: "none",
    ...overrides,
  } as Report;
}

describe("Traffic Analytics Aggregation Engine", () => {
  it("aggregates vehicle class breakdown correctly", () => {
    const reports: Report[] = [
      createMockReport({ className: "car", trackId: 1 }),
      createMockReport({ className: "car", trackId: 2 }),
      createMockReport({ className: "motorcycle", trackId: 3 }),
      createMockReport({ className: "truck", trackId: 4 }),
      createMockReport({ className: "bus", trackId: 5 }),
    ];

    const analytics = computeTrafficAnalytics(reports);
    expect(analytics.totalObservations).toBe(5);
    expect(analytics.totalUniqueVehicles).toBe(5);

    const carClass = analytics.vehicleClasses.find((c) => c.category === "car");
    expect(carClass?.count).toBe(2);
    expect(carClass?.percentage).toBe(40);

    const motoClass = analytics.vehicleClasses.find((c) => c.category === "motorcycle");
    expect(motoClass?.count).toBe(1);
    expect(motoClass?.percentage).toBe(20);
  });

  it("computes speed compliance rate and distribution buckets", () => {
    const reports: Report[] = [
      // 30 km/h (within 50 km/h limit)
      createMockReport({ speedMps: 8.33, trackId: 1 }),
      // 45 km/h (within 50 km/h limit)
      createMockReport({ speedMps: 12.5, trackId: 2 }),
      // 70 km/h (speeding violation)
      createMockReport({ speedMps: 19.44, trackId: 3 }),
      // 85 km/h (speeding violation)
      createMockReport({ speedMps: 23.61, trackId: 4 }),
    ];

    const analytics = computeTrafficAnalytics(reports);
    expect(analytics.speedStats.measuredCount).toBe(4);
    expect(analytics.speedStats.violationsCount).toBe(2);
    expect(analytics.speedStats.compliantCount).toBe(2);
    expect(analytics.speedStats.complianceRate).toBe(50);
    expect(analytics.speedStats.maxSpeedKmh).toBe(85);

    // Verify speed histogram buckets
    const bucket21to40 = analytics.speedDistribution.find((b) => b.range === "21-40");
    expect(bucket21to40?.count).toBe(1); // 30 km/h

    const bucket41to60 = analytics.speedDistribution.find((b) => b.range === "41-60");
    expect(bucket41to60?.count).toBe(1); // 45 km/h

    const bucket61to80 = analytics.speedDistribution.find((b) => b.range === "61-80");
    expect(bucket61to80?.count).toBe(1); // 70 km/h

    const bucket80plus = analytics.speedDistribution.find((b) => b.range === "80+");
    expect(bucket80plus?.count).toBe(1); // 85 km/h
  });

  it("extracts Indian plate demographics and Bharat series counts", () => {
    const reports: Report[] = [
      createMockReport({ plateText: "MH 12 AB 1234", plateStatus: "read" }),
      createMockReport({ plateText: "MH 02 CD 5678", plateStatus: "read" }),
      createMockReport({ plateText: "DL 01 EF 9012", plateStatus: "read" }),
      createMockReport({ plateText: "22 BH 1234 AA", plateStatus: "read" }),
    ];

    const analytics = computeTrafficAnalytics(reports);
    expect(analytics.plateStats.confirmedIndianPlates).toBe(4);
    expect(analytics.plateStats.bharatSeriesPlates).toBe(1);

    const mhState = analytics.plateStats.topOriginStates.find((s) => s.stateCode === "MH");
    expect(mhState?.count).toBe(2);
    expect(mhState?.percentage).toBe(50);

    const dlState = analytics.plateStats.topOriginStates.find((s) => s.stateCode === "DL");
    expect(dlState?.count).toBe(1);
    expect(dlState?.percentage).toBe(25);
  });

  it("generates structured CSV output containing all summary sections", () => {
    const reports: Report[] = [
      createMockReport({ className: "car", speedMps: 15, plateText: "MH 12 AB 1234" }),
    ];
    const analytics = computeTrafficAnalytics(reports);
    const csv = generateAnalyticsCsv(analytics);

    expect(csv).toContain("RoadLens AI Traffic Analytics Summary Report");
    expect(csv).toContain("Total Observations,1");
    expect(csv).toContain("Speed Compliance Rate");
    expect(csv).toContain("Vehicle Class Distribution");
    expect(csv).toContain("Speed Distribution");
    expect(csv).toContain("Indian Plate Origin Demographics");
    expect(csv).toContain("MH,\"Maharashtra\",1,100%");
  });
});
