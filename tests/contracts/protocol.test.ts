import { describe, expect, it } from "vitest";
import {
  BboxSchema,
  ControlSchema,
  DetectionSchema,
  FrameSchema,
  HelloSchema,
  PacketHeaderSchema,
  PolicySchema,
  ReportSchema,
  TrackSchema,
  type PacketHeader,
} from "../../shared/src/schemas";
import { decodePacket, encodePacket } from "../../shared/src/packets";
import { LIMITS } from "../../shared/src/limits";
import { epoch, frame, markerJpeg, policy, report, uuid } from "./fixtures";
const header = (size = 4): PacketHeader => ({
  v: 2,
  type: "analysis.frame",
  frameId: frame().frameId,
  result: frame(),
  imageWidth: 640,
  imageHeight: 360,
  imageLength: size,
});
function rawPacket(value: unknown, jpeg = markerJpeg()) {
  const json = new TextEncoder().encode(JSON.stringify(value)),
    bytes = new Uint8Array(8 + json.length + jpeg.length);
  bytes.set([82, 76, 78, 50]);
  new DataView(bytes.buffer).setUint32(4, json.length);
  bytes.set(json, 8);
  bytes.set(jpeg, 8 + json.length);
  return bytes;
}
describe("B02 shared semantic, coordinate and source-time contracts (synthetic metadata)", () => {
  it("accepts a complete synthetic frame and metadata-only observation", () => {
    expect(FrameSchema.parse(frame()).sourceMode).toBe("synthetic_test");
    expect(ReportSchema.parse(report()).speedMps).toBeNull();
  });
  it.each(
    [
      [0.4, 0.2, 0.2, 0.5],
      [0.2, 0.2, 0.2, 0.5],
      [-0.1, 0, 0.2, 1],
      [0, 0, 1.1, 1],
      [0, 0, NaN, 1],
      [0, 0, Infinity, 1],
      [0, 0, 1],
    ].map((bbox) => ({ bbox })),
  )("rejects malformed normalized box $bbox", ({ bbox }) => {
    expect(BboxSchema.safeParse(bbox).success).toBe(false);
  });
  it("rejects family-specific numeric classes and unknown detection fields", () => {
    expect(
      DetectionSchema.safeParse({
        className: 2,
        score: 0.8,
        bbox: [0, 0, 1, 1],
      }).success,
    ).toBe(false);
    expect(
      DetectionSchema.safeParse({
        className: "car",
        score: 0.8,
        bbox: [0, 0, 1, 1],
        owner: true,
      }).success,
    ).toBe(false);
  });
  it("requires exact frame ID/epoch/sequence binding", () => {
    expect(
      FrameSchema.safeParse({ ...frame(), frameId: `${epoch}:999` }).success,
    ).toBe(false);
    expect(FrameSchema.safeParse({ ...frame(), frameSeq: 1.5 }).success).toBe(
      false,
    );
    expect(
      FrameSchema.safeParse({
        ...frame(),
        frameSeq: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });
  it.each(["sourceTimeMs", "inferenceMs", "analysisHz"] as const)(
    "rejects nonfinite %s",
    (field) => {
      expect(FrameSchema.safeParse({ ...frame(), [field]: NaN }).success).toBe(
        false,
      );
      expect(
        FrameSchema.safeParse({ ...frame(), [field]: Infinity }).success,
      ).toBe(false);
      expect(FrameSchema.safeParse({ ...frame(), [field]: -1 }).success).toBe(
        false,
      );
    },
  );
  it("requires lowercase SHA256, known protocol and valid source clock metadata", () => {
    expect(
      FrameSchema.safeParse({ ...frame(), modelSha256: "A".repeat(64) })
        .success,
    ).toBe(false);
    expect(FrameSchema.safeParse({ ...frame(), v: 1 }).success).toBe(false);
    expect(
      FrameSchema.safeParse({ ...frame(), capturedAtIso: "yesterday" }).success,
    ).toBe(false);
  });
  it("bounds tracks, dimensions and snapshot batches", () => {
    const f = frame();
    expect(
      FrameSchema.safeParse({
        ...f,
        tracks: Array(LIMITS.tracks + 1).fill(f.tracks[0]),
      }).success,
    ).toBe(false);
    expect(FrameSchema.safeParse({ ...f, frameWidth: 0 }).success).toBe(false);
    expect(FrameSchema.safeParse({ ...f, frameHeight: 8193 }).success).toBe(
      false,
    );
    expect(
      ControlSchema.safeParse({
        v: 2,
        type: "state.snapshot",
        requestId: uuid(1),
        reports: Array(11).fill(report()),
        done: true,
      }).success,
    ).toBe(false);
  });
  it("requires unavailable speed null with a reason and valid speed without an error", () => {
    const t = frame().tracks[0]!;
    expect(TrackSchema.safeParse({ ...t, speedMps: 0 }).success).toBe(false);
    expect(TrackSchema.safeParse({ ...t, speedReason: null }).success).toBe(
      false,
    );
    expect(
      TrackSchema.safeParse({
        ...t,
        speedStatus: "valid_estimate",
        speedMps: 10,
        speedReason: null,
      }).success,
    ).toBe(true);
  });
  it("rejects numeric speed on predicted-only track views", () => {
    expect(
      TrackSchema.safeParse({
        ...frame().tracks[0],
        observed: false,
        speedMps: 10,
        speedStatus: "valid_estimate",
        speedReason: null,
      }).success,
    ).toBe(false);
  });
  it("binds report frame identity to its capture epoch", () => {
    expect(
      ReportSchema.safeParse({ ...report(), frameId: `${uuid(99)}:1` }).success,
    ).toBe(false);
  });
  it("does not allow a candidate report with missing measured speed", () => {
    expect(
      ReportSchema.safeParse({ ...report(), kind: "speed_candidate" }).success,
    ).toBe(false);
  });
  it("bounds UTF8 metadata bytes and trajectory length", () => {
    expect(
      ReportSchema.safeParse({
        ...report(),
        validityReasons: Array(8).fill("界".repeat(160)),
      }).success,
    ).toBe(false);
    expect(
      ReportSchema.safeParse({
        ...report(),
        evidenceSummary: {
          trajectory: Array(9).fill([0, 0, 0]),
          residualM: null,
          coverageMs: null,
        },
      }).success,
    ).toBe(false);
  });
  it("accepts only operator-entered demo limits and nonnegative margins", () => {
    expect(
      PolicySchema.safeParse({ ...policy(), limitSource: "government" })
        .success,
    ).toBe(false);
    expect(
      PolicySchema.safeParse({ ...policy(), demoMarginMps: -1 }).success,
    ).toBe(false);
    expect(
      PolicySchema.safeParse({ ...policy(), speedLimitMps: 101 }).success,
    ).toBe(false);
  });
});
describe("B11 strict handshake and request routing fields", () => {
  const hello = () => ({
    v: 2,
    type: "hello",
    roomId: uuid(1),
    role: "camera",
    token: "a".repeat(43),
  });
  it("accepts only camera/viewer role and fixed capability encoding", () => {
    expect(HelloSchema.safeParse(hello()).success).toBe(true);
    expect(HelloSchema.safeParse({ ...hello(), role: "admin" }).success).toBe(
      false,
    );
    expect(
      HelloSchema.safeParse({ ...hello(), token: "x".repeat(44) }).success,
    ).toBe(false);
    expect(
      HelloSchema.safeParse({ ...hello(), token: "a".repeat(42) + "/" })
        .success,
    ).toBe(false);
  });
  it("rejects unsolicited role/room/recipient fields on routed requests", () => {
    const request = {
      v: 2,
      type: "review.request",
      requestId: uuid(1),
      reportId: uuid(2),
      expectedRevision: 0,
      review: "noted",
    };
    expect(ControlSchema.safeParse(request).success).toBe(true);
    for (const field of ["role", "roomId", "viewerId", "targetId"])
      expect(
        ControlSchema.safeParse({ ...request, [field]: uuid(8) }).success,
      ).toBe(false);
  });
  it("rejects unknown controls, revisions and snapshot schemas", () => {
    expect(
      ControlSchema.safeParse({ v: 2, type: "delete.everything" }).success,
    ).toBe(false);
    expect(
      ControlSchema.safeParse({
        v: 2,
        type: "review.request",
        requestId: uuid(1),
        reportId: uuid(2),
        expectedRevision: -1,
        review: "noted",
      }).success,
    ).toBe(false);
    expect(
      ControlSchema.safeParse({
        v: 2,
        type: "state.snapshot",
        requestId: uuid(1),
        reports: [],
        done: true,
        roomId: uuid(2),
      }).success,
    ).toBe(false);
  });
});
describe("B14/B44 RLN2 atomic envelopes (marker JPEGs, not model validation)", () => {
  it("round-trips image and matching result atomically, including a subarray byte offset", () => {
    const packet = encodePacket(header(), markerJpeg()),
      padded = new Uint8Array(packet.length + 14);
    padded.set(packet, 7);
    const decoded = decodePacket(padded.subarray(7, 7 + packet.length));
    expect(decoded.header).toEqual(header());
    expect(decoded.jpeg).toEqual(markerJpeg());
  });
  it("encodes bounded correlated evidence separately from analysis metadata", () => {
    const h: PacketHeader = {
      v: 2,
      type: "evidence.frame",
      requestId: uuid(1),
      evidenceId: uuid(2),
      imageLength: 4,
      imageWidth: 10,
      imageHeight: 10,
    };
    expect(decodePacket(encodePacket(h, markerJpeg())).header).toEqual(h);
    expect(
      PacketHeaderSchema.safeParse({ ...h, result: frame() }).success,
    ).toBe(false);
  });
  it("rejects metadata referring to a different displayed frame", () => {
    expect(() =>
      encodePacket(
        { ...header(), frameId: `${epoch}:99` } as PacketHeader,
        markerJpeg(),
      ),
    ).toThrow();
  });
  it("rejects malformed magic, protocol version, short and truncated envelopes", () => {
    const packet = encodePacket(header(), markerJpeg());
    packet[0] = 0;
    expect(() => decodePacket(packet)).toThrow();
    expect(() => decodePacket(new Uint8Array(11))).toThrow();
    expect(() => decodePacket(rawPacket({ ...header(), v: 1 }))).toThrow();
    expect(() =>
      decodePacket(encodePacket(header(), markerJpeg()).subarray(0, 100)),
    ).toThrow();
  });
  it("rejects malformed UTF8 before parsing JSON", () => {
    const packet = encodePacket(header(), markerJpeg());
    packet[8] = 0xc3;
    packet[9] = 0x28;
    expect(() => decodePacket(packet)).toThrow();
  });
  it("rejects zero, excessive and out-of-bounds declared JSON header lengths", () => {
    for (const length of [0, 1, LIMITS.headerBytes + 1, 0xffffffff]) {
      const packet = encodePacket(header(), markerJpeg());
      new DataView(packet.buffer).setUint32(4, length);
      expect(() => decodePacket(packet)).toThrow();
    }
  });
  it("enforces JPEG declared length, marker sanity and hard byte cap", () => {
    expect(() => encodePacket(header(5), markerJpeg())).toThrow();
    expect(() => decodePacket(rawPacket(header(5)))).toThrow();
    expect(() => encodePacket(header(), new Uint8Array(4))).toThrow();
    expect(() =>
      decodePacket(rawPacket(header(), new Uint8Array(4))),
    ).toThrow();
    expect(() =>
      encodePacket(
        header(LIMITS.jpegBytes + 1),
        markerJpeg(LIMITS.jpegBytes + 1),
      ),
    ).toThrow();
    const packet = encodePacket(
      header(LIMITS.jpegBytes),
      markerJpeg(LIMITS.jpegBytes),
    );
    expect(decodePacket(packet).jpeg.length).toBe(LIMITS.jpegBytes);
  });
  it("enforces full message and decoded-size declarations independently", () => {
    expect(() =>
      decodePacket(new Uint8Array(LIMITS.messageBytes + 1)),
    ).toThrow();
    expect(() =>
      decodePacket(rawPacket({ ...header(), imageWidth: 641 })),
    ).toThrow();
    expect(() =>
      decodePacket(rawPacket({ ...header(), imageHeight: 0 })),
    ).toThrow();
  });
  it("measures JSON header caps in UTF8 bytes rather than character count", () => {
    const h = header();
    if (h.type !== "analysis.frame") throw new Error("fixture");
    h.result.tracks = Array.from({ length: 100 }, (_, i) => ({
      ...h.result.tracks[0]!,
      trackId: i,
      speedReason: "界".repeat(150),
    }));
    expect(PacketHeaderSchema.safeParse(h).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(h)).length).toBeGreaterThan(
      LIMITS.headerBytes,
    );
    expect(() => encodePacket(h, markerJpeg())).toThrow();
    expect(() => decodePacket(rawPacket(h))).toThrow();
  });
  it("rejects role and room secrets inserted into binary metadata", () => {
    expect(() =>
      decodePacket(
        rawPacket({
          ...header(),
          role: "camera",
          token: "a".repeat(43),
          roomId: uuid(9),
        }),
      ),
    ).toThrow();
  });
});
