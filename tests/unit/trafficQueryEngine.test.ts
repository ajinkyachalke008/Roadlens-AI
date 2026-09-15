import { describe, it, expect } from "vitest";
import {
  parseNaturalLanguageQuery,
  executeTrafficQuery,
  type VehicleRecord,
} from "../../frontend/src/ai/trafficQueryEngine";

const sampleRecords: VehicleRecord[] = [
  {
    id: "rep-1",
    reportId: "rep-1",
    className: "car",
    color: { name: "Red", hex: "#dc2626", emoji: "🔴", confidence: 0.9 },
    plateText: "MH 12 AB 1234",
    stateName: "Maharashtra",
    rtoLocation: "Pune RTO",
    speedKmh: 45,
    isSpeeding: false,
    timestamp: "2026-09-15T10:30:00.000Z",
  },
  {
    id: "rep-2",
    reportId: "rep-2",
    className: "car",
    color: { name: "White", hex: "#f8fafc", emoji: "⚪", confidence: 0.85 },
    plateText: "DL 01 C 9999",
    stateName: "Delhi",
    rtoLocation: "Mall Road",
    speedKmh: 68,
    isSpeeding: true,
    timestamp: "2026-09-15T10:31:00.000Z",
  },
  {
    id: "rep-3",
    reportId: "rep-3",
    className: "truck",
    color: { name: "Blue", hex: "#2563eb", emoji: "🔵", confidence: 0.92 },
    plateText: "MH 14 CC 5555",
    stateName: "Maharashtra",
    rtoLocation: "Pimpri-Chinchwad",
    speedKmh: 40,
    isSpeeding: false,
    timestamp: "2026-09-15T10:32:00.000Z",
  },
  {
    id: "rep-4",
    reportId: "rep-4",
    className: "car",
    color: { name: "Red", hex: "#dc2626", emoji: "🔴", confidence: 0.88 },
    plateText: null, // Unscanned
    speedKmh: 52,
    isSpeeding: true,
    timestamp: "2026-09-15T10:33:00.000Z",
  },
  {
    id: "rep-5",
    reportId: "rep-5",
    className: "motorcycle",
    color: { name: "Black", hex: "#1e293b", emoji: "⚫", confidence: 0.8 },
    plateText: "KA 03 XY 7890",
    stateName: "Karnataka",
    rtoLocation: "Bengaluru East",
    speedKmh: 35,
    isSpeeding: false,
    violations: ["MV Act Sec 194C (Triple Riding)"],
    timestamp: "2026-09-15T10:34:00.000Z",
  },
];

describe("trafficQueryEngine", () => {
  it("parses color, vehicle class, and plate requirements from natural language queries", () => {
    const parsed1 = parseNaturalLanguageQuery("Find all red cars and their number plate");
    expect(parsed1.targetColor).toBe("Red");
    expect(parsed1.targetClass).toBe("car");
    expect(parsed1.requirePlate).toBe(true);

    const parsed2 = parseNaturalLanguageQuery("Show speeding trucks over 50 km/h");
    expect(parsed2.targetClass).toBe("truck");
    expect(parsed2.speedingOnly).toBe(true);
    expect(parsed2.minSpeedKmh).toBe(50);

    const parsed3 = parseNaturalLanguageQuery("Find two-wheelers with violations");
    expect(parsed3.targetClass).toBe("motorcycle");
    expect(parsed3.violationsOnly).toBe(true);
  });

  it("filters red cars and generates conversational summary", () => {
    const result = executeTrafficQuery("Find all red cars and their number plate", sampleRecords);
    expect(result.totalCount).toBe(2);
    expect(result.matchedRecords.every((r) => r.color.name === "Red" && r.className === "car")).toBe(true);
    expect(result.summaryText).toContain("Found 2 red cars observed by this camera");
    expect(result.summaryText).toContain("1 has scanned Indian number plates");
  });

  it("filters speeding vehicles above threshold", () => {
    const result = executeTrafficQuery("Show vehicles speeding over 60 km/h", sampleRecords);
    expect(result.totalCount).toBe(1);
    expect(result.matchedRecords[0].id).toBe("rep-2");
    expect(result.matchedRecords[0].speedKmh).toBe(68);
  });

  it("filters two-wheelers with violations", () => {
    const result = executeTrafficQuery("Find bikes with violations", sampleRecords);
    expect(result.totalCount).toBe(1);
    expect(result.matchedRecords[0].className).toBe("motorcycle");
    expect(result.matchedRecords[0].violations).toContain("MV Act Sec 194C (Triple Riding)");
  });

  it("handles zero match gracefully with informative reply", () => {
    const result = executeTrafficQuery("Find green cars", sampleRecords);
    expect(result.totalCount).toBe(0);
    expect(result.summaryText).toContain("No green cars found");
  });
});
