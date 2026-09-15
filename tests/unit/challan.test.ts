import { describe, expect, it } from "vitest";
import {
  calculateIndianTrafficFine,
  generateChallanNoticeNumber,
  createEChallanFromReport,
  getIndianVehicleCategoryName,
} from "../../frontend/src/challan/challanGenerator";
import type { Report } from "../../shared/src/schemas";

describe("e-Challan Generator & Indian Motor Vehicles Act Fines", () => {
  it("calculates Section 183(1) fine for speeding Light Motor Vehicle (Car)", () => {
    // 50 km/h speed limit = ~13.88 m/s, vehicle at 70 km/h = ~19.44 m/s (excess +20 km/h)
    const result = calculateIndianTrafficFine("car", 19.44, 13.88);
    expect(result.isViolation).toBe(true);
    expect(result.excessKmh).toBe(20);
    expect(result.penaltyInr).toBe(1000);
    expect(result.section).toContain("Section 183(1)");
    expect(result.title).toContain("Light Motor Vehicle");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amount).toBe(1000);
  });

  it("calculates higher fine for severe speeding in Light Motor Vehicle (> 30 km/h excess)", () => {
    // 40 km/h limit (11.11 m/s), vehicle at 75 km/h (20.83 m/s) -> +35 km/h excess
    const result = calculateIndianTrafficFine("car", 20.83, 11.11);
    expect(result.isViolation).toBe(true);
    expect(result.excessKmh).toBe(35);
    expect(result.penaltyInr).toBe(2000);
  });

  it("calculates Section 183(2) fine for speeding Heavy Vehicle (Truck/Bus)", () => {
    // 40 km/h limit (11.11 m/s), truck at 60 km/h (16.66 m/s) -> +20 km/h excess
    const result = calculateIndianTrafficFine("truck", 16.66, 11.11);
    expect(result.isViolation).toBe(true);
    expect(result.penaltyInr).toBe(2000);
    expect(result.section).toContain("Section 183(2)");
    expect(result.title).toContain("Heavy Goods");
  });

  it("calculates Section 183(1) fine for speeding Motorcycle", () => {
    // 50 km/h limit, bike at 70 km/h
    const result = calculateIndianTrafficFine("motorcycle", 19.44, 13.88);
    expect(result.isViolation).toBe(true);
    expect(result.penaltyInr).toBe(1000);
    expect(result.title).toContain("Two-Wheeler");
  });

  it("assigns Section 177 general observation notice for non-speeding vehicles", () => {
    // 50 km/h limit, car at 42 km/h
    const result = calculateIndianTrafficFine("car", 11.66, 13.88);
    expect(result.isViolation).toBe(false);
    expect(result.excessKmh).toBe(0);
    expect(result.penaltyInr).toBe(500);
    expect(result.section).toContain("Section 177");
  });

  it("generates authentic Challan Notice ID conforming to State-Year-CH-Random format", () => {
    const challanId = generateChallanNoticeNumber("MH", new Date("2026-09-15"));
    expect(challanId).toMatch(/^MH-2026-CH-\d{6}$/);

    const delhiId = generateChallanNoticeNumber("DL", new Date("2026-01-01"));
    expect(delhiId).toMatch(/^DL-2026-CH-\d{6}$/);
  });

  it("maps Indian vehicle categories to English and Hindi descriptions", () => {
    expect(getIndianVehicleCategoryName("car").en).toContain("Light Motor Vehicle");
    expect(getIndianVehicleCategoryName("car").hi).toContain("हल्का मोटर वाहन");
    expect(getIndianVehicleCategoryName("truck").en).toContain("Heavy Goods");
    expect(getIndianVehicleCategoryName("motorcycle").en).toContain("Two-Wheeler");
  });

  it("creates a full e-Challan notice document from a session Report", () => {
    const sampleReport: Report = {
      reportId: "rep-001",
      revision: 1,
      sourceId: "source-1",
      captureEpoch: "epoch-1",
      frameId: "f-100",
      trackId: 14,
      sourceMode: "live_camera",
      sourceTimeMs: 12000,
      capturedAtIso: "2026-09-15T09:15:00.000Z",
      kind: "observation",
      className: "car",
      score: 0.92,
      speedMps: 18.05, // ~65 km/h
      policy: {
        version: "p-1",
        roadLabel: "Main Road",
        speedLimitMps: 11.11, // 40 km/h limit
        demoMarginMps: 1.38,
        limitSource: "operator_entered_demo",
      },
      validityReasons: [],
      evidenceSummary: {
        trajectory: [],
        residualM: null,
        coverageMs: null,
      },
      measurementFrameId: "f-100",
      measurementSourceTimeMs: 12000,
      modelId: "yolo26n",
      modelSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      detectorProfile: "profile-1",
      trackerVersion: "track-1",
      calibrationVersion: "cal-1",
      review: "pending",
      evidenceState: "none",
      plateStatus: "read",
      plateText: "MH 12 AB 1234",
      plateConfidence: 0.94,
    } as unknown as Report;

    const notice = createEChallanFromReport(sampleReport, {
      event: "blob:http://localhost/ev1",
      plate: "blob:http://localhost/plate1",
    });

    expect(notice.challanId).toMatch(/^MH-\d{4}-CH-\d{6}$/);
    expect(notice.registrationNumber).toBe("MH 12 AB 1234");
    expect(notice.stateCode).toBe("MH");
    expect(notice.stateName).toBe("Maharashtra");
    expect(notice.rtoLocation).toBe("Pune");
    expect(notice.isRegisteredPlate).toBe(true);
    expect(notice.isSpeedViolation).toBe(true);
    expect(notice.speedKmh).toBe(65);
    expect(notice.speedLimitKmh).toBe(40);
    expect(notice.excessSpeedKmh).toBe(25);
    expect(notice.totalPenaltyInr).toBe(1000);
    expect(notice.evidenceSnapshotUrl).toBe("blob:http://localhost/ev1");
    expect(notice.plateCutoutUrl).toBe("blob:http://localhost/plate1");
    expect(notice.paymentStatus).toBe("PENDING");
  });
});
