import { describe, expect, it } from "vitest";
import {
  PlateErrorSchema,
  PlateFrameHeaderSchema,
  PlateResultSchema,
  PlateTextSchema,
  decodePlateFrame,
  encodePlateFrame,
  isPlateFrame,
  samePlateRequest,
  type PlateFrameHeader,
} from "../../shared/src/plates";
import { encodeGpuFrame } from "../../shared/src/gpu";
import { PLATE_LIMITS } from "../../shared/src/limits";
import { ReportSchema } from "../../shared/src/schemas";
import { epoch, report, sourceId, uuid } from "./fixtures";
import { gpuHeader, markerJpeg } from "./gpu.test";

const crop = markerJpeg(320, 240);
const plateHeader = (): PlateFrameHeader => ({
  v: 1,
  type: "camera.plate",
  format: "image/jpeg",
  roomId: uuid(1),
  sourceId,
  captureEpoch: epoch,
  requestId: uuid(9),
  frameSeq: 4,
  frameId: `${epoch}:4`,
  trackId: 7,
  sourceTimeMs: 800,
  sourceWidth: 1920,
  sourceHeight: 1080,
  cropX: 0.3,
  cropY: 0.4,
  cropWidth: 0.25,
  cropHeight: 0.3,
  encodedWidth: 320,
  encodedHeight: 240,
  imageLength: crop.length,
});

describe("Plate transport envelope", () => {
  it("round-trips a vehicle crop through its own RLP1 envelope", () => {
    const bytes = encodePlateFrame(plateHeader(), crop);
    expect(isPlateFrame(bytes)).toBe(true);
    const decoded = decodePlateFrame(bytes);
    expect(decoded.header).toEqual(plateHeader());
    expect([...decoded.jpeg]).toEqual([...crop]);
  });
  it("keeps plate crops and analysis frames distinguishable", () => {
    const analysis = encodeGpuFrame(gpuHeader(), markerJpeg());
    expect(isPlateFrame(analysis)).toBe(false);
    expect(() => decodePlateFrame(analysis)).toThrow();
  });
  it("rejects a crop that claims to reach outside its own source frame", () => {
    expect(() =>
      PlateFrameHeaderSchema.parse({ ...plateHeader(), cropX: 0.9 }),
    ).toThrow();
    expect(() =>
      PlateFrameHeaderSchema.parse({ ...plateHeader(), cropHeight: 0 }),
    ).toThrow();
  });
  it("refuses a crop too small to hold a legible plate", () => {
    const small = PLATE_LIMITS.minCropEdge - 1;
    expect(() =>
      PlateFrameHeaderSchema.parse({
        ...plateHeader(),
        encodedWidth: small,
        encodedHeight: small,
      }),
    ).toThrow();
  });
  it("bounds the crop payload well below the analysis frame budget", () => {
    expect(PLATE_LIMITS.jpegBytes).toBeLessThan(PLATE_LIMITS.messageBytes);
    expect(() =>
      PlateFrameHeaderSchema.parse({
        ...plateHeader(),
        imageLength: PLATE_LIMITS.jpegBytes + 1,
      }),
    ).toThrow();
  });
  it("rejects a header carrying any field the protocol does not define", () => {
    expect(() =>
      PlateFrameHeaderSchema.parse({ ...plateHeader(), plateText: "ABC1234" }),
    ).toThrow();
    expect(() =>
      PlateFrameHeaderSchema.parse({ ...plateHeader(), extra: 1 }),
    ).toThrow();
  });
  it("rejects a result carrying any field the protocol does not define", () => {
    expect(() =>
      PlateResultSchema.parse({ ...plateResult(), cropX: 0.3 }),
    ).toThrow();
  });
  it("ties frameId to its epoch and sequence", () => {
    expect(() =>
      PlateFrameHeaderSchema.parse({ ...plateHeader(), frameId: `${epoch}:5` }),
    ).toThrow();
  });
});

const plateResult = (over: Record<string, unknown> = {}) => ({
  v: 1 as const,
  type: "plate.result" as const,
  roomId: uuid(1),
  sourceId,
  captureEpoch: epoch,
  requestId: uuid(9),
  frameSeq: 4,
  frameId: `${epoch}:4`,
  trackId: 7,
  sourceTimeMs: 800,
  detectorId: "plate-detector-v1",
  detectorSha256: "b".repeat(64),
  ocrEngine: "fast-plate-ocr",
  inputSize: 640,
  plateText: "ABC1234",
  plateConfidence: 0.91,
  detectorConfidence: 0.8,
  plateBox: [0.1, 0.2, 0.6, 0.4],
  metrics: { decodeMs: 1, detectMs: 3, ocrMs: 4, totalMs: 8 },
  ...over,
});

describe("Plate result contract", () => {
  it("accepts a reading and its confidence together", () => {
    expect(PlateResultSchema.parse(plateResult()).plateText).toBe("ABC1234");
  });
  it("treats an unread plate as a valid observation, not an error", () => {
    const parsed = PlateResultSchema.parse(
      plateResult({ plateText: null, plateConfidence: null }),
    );
    expect(parsed.plateText).toBeNull();
  });
  it("refuses text without confidence, or confidence without text", () => {
    expect(() =>
      PlateResultSchema.parse(plateResult({ plateConfidence: null })),
    ).toThrow();
    expect(() =>
      PlateResultSchema.parse(plateResult({ plateText: null })),
    ).toThrow();
  });
  it("refuses readings outside the permitted plate alphabet", () => {
    for (const text of [
      "abc1234",
      "AB!123",
      "",
      "A",
      "A".repeat(PLATE_LIMITS.maxTextLength + 1),
      " AB12",
    ])
      expect(() => PlateTextSchema.parse(text)).toThrow();
    for (const text of ["ABC1234", "7ABC123", "AB-1234", "1A 2B3"])
      expect(PlateTextSchema.parse(text)).toBe(text);
  });
  it("refuses a degenerate plate box", () => {
    expect(() =>
      PlateResultSchema.parse(plateResult({ plateBox: [0.6, 0.2, 0.1, 0.4] })),
    ).toThrow();
  });
  it("correlates only on exact request identity", () => {
    const a = PlateResultSchema.parse(plateResult());
    expect(samePlateRequest(a, PlateResultSchema.parse(plateResult()))).toBe(
      true,
    );
    expect(
      samePlateRequest(a, PlateResultSchema.parse(plateResult({ trackId: 8 }))),
    ).toBe(false);
    expect(
      samePlateRequest(
        a,
        PlateResultSchema.parse(plateResult({ requestId: uuid(10) })),
      ),
    ).toBe(false);
  });
  it("names only fixed plate failure categories", () => {
    for (const code of [
      "decode_failed",
      "plate_failed",
      "busy",
      "timeout",
      "unavailable",
    ])
      expect(
        PlateErrorSchema.parse({
          v: 1,
          type: "plate.error",
          roomId: uuid(1),
          requestId: uuid(9),
          code,
        }).code,
      ).toBe(code);
    expect(() =>
      PlateErrorSchema.parse({
        v: 1,
        type: "plate.error",
        roomId: uuid(1),
        requestId: uuid(9),
        code: "no_plate",
      }),
    ).toThrow();
  });
});

describe("Report compatibility with plate fields", () => {
  it("still accepts a report that carries no plate fields at all", () => {
    const parsed = ReportSchema.parse(report());
    expect(parsed.plateStatus).toBeUndefined();
    expect(parsed.plateText).toBeUndefined();
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(report()));
  });
  it("accepts every plate status a camera can report", () => {
    for (const plateStatus of ["unavailable", "pending", "unreadable"] as const)
      expect(
        ReportSchema.parse({
          ...report(),
          plateStatus,
          plateText: null,
          plateConfidence: null,
          plateSupportingFrames: 0,
          plateDetectorConfidence: null,
        }).plateStatus,
      ).toBe(plateStatus);
    expect(
      ReportSchema.parse({
        ...report(),
        plateStatus: "read",
        plateText: "ABC1234",
        plateConfidence: 0.9,
        plateSupportingFrames: PLATE_LIMITS.minSupportingFrames,
        plateDetectorConfidence: 0.8,
      }).plateText,
    ).toBe("ABC1234");
  });
  it("refuses a reading that no frames agreed on", () => {
    expect(() =>
      ReportSchema.parse({
        ...report(),
        plateStatus: "read",
        plateText: "ABC1234",
        plateConfidence: 0.9,
        plateSupportingFrames: PLATE_LIMITS.minSupportingFrames - 1,
        plateDetectorConfidence: 0.8,
      }),
    ).toThrow();
  });
  it("refuses plate text on any status other than read", () => {
    expect(() =>
      ReportSchema.parse({
        ...report(),
        plateStatus: "pending",
        plateText: "ABC1234",
        plateConfidence: 0.9,
        plateSupportingFrames: 2,
        plateDetectorConfidence: 0.8,
      }),
    ).toThrow();
  });
  it("refuses plate text with no status to explain it", () => {
    expect(() =>
      ReportSchema.parse({ ...report(), plateText: "ABC1234" }),
    ).toThrow();
  });
  it("keeps a strong one-frame candidate separate from confirmed plate text", () => {
    const parsed = ReportSchema.parse({
      ...report(),
      plateStatus: "pending",
      plateText: null,
      plateConfidence: null,
      plateSupportingFrames: 1,
      plateDetectorConfidence: 0.9,
      plateCandidateText: "ABC1234",
      plateCandidateConfidence: 0.94,
      plateCandidateSupportingFrames: 1,
      plateAttemptFrames: 1,
      plateLocalizedFrames: 1,
      plateReadableFrames: 1,
    });
    expect(parsed.plateText).toBeNull();
    expect(parsed.plateCandidateText).toBe("ABC1234");
    expect(() =>
      ReportSchema.parse({
        ...parsed,
        plateStatus: "read",
        plateText: "ABC1234",
        plateConfidence: 0.94,
        plateSupportingFrames: 2,
      }),
    ).toThrow();
  });
  it("accepts separately identified RAM-only best-capture metadata", () => {
    expect(
      ReportSchema.parse({
        ...report(),
        bestCapture: {
          imageId: uuid(91),
          state: "available",
          frameId: report().frameId,
          sourceTimeMs: report().sourceTimeMs,
          width: 1024,
          height: 576,
          quality: 0.82,
          sharpness: 12.4,
        },
        bestPlateDetail: {
          imageId: uuid(92),
          state: "available",
          frameId: report().frameId,
          sourceTimeMs: report().sourceTimeMs,
          width: 92,
          height: 28,
          quality: 0.78,
          sharpness: 11,
        },
      }).bestCapture?.width,
    ).toBe(1024);
  });
  it("keeps a plate-bearing report inside the report byte budget", () => {
    const full = ReportSchema.parse({
      ...report(),
      validityReasons: Array.from({ length: 8 }, () => "x".repeat(40)),
      evidenceSummary: {
        trajectory: Array.from({ length: 8 }, (_unused, index) => [
          index * 100,
          1.5,
          2.5,
        ]) as [number, number, number][],
        residualM: 0.25,
        coverageMs: 1200,
      },
      plateStatus: "read",
      plateText: "ABC123456",
      plateConfidence: 0.9123456,
      plateSupportingFrames: PLATE_LIMITS.framesPerTrack,
      plateDetectorConfidence: 0.8234567,
      evidenceId: uuid(5),
      evidenceState: "available",
    });
    expect(new TextEncoder().encode(JSON.stringify(full)).length).toBeLessThan(
      2048,
    );
  });
});
