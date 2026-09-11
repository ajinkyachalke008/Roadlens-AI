import { describe, expect, it } from "vitest";
import {
  decodeGpuFrame,
  encodeGpuFrame,
  GpuFrameHeaderSchema,
  GpuResultSchema,
  GpuHelloSchema,
  WorkerRegisterSchema,
  sameGpuFrame,
  type GpuFrameHeader,
} from "../../shared/src/gpu";
import { GPU_LIMITS } from "../../shared/src/limits";
import { epoch, sourceId, uuid } from "./fixtures";
// Header-only JPEG fixture: tests validation, not inference or actual image decoding.
export const markerJpeg = (w = 640, h = 360) =>
  new Uint8Array([
    255,
    216,
    255,
    192,
    0,
    11,
    8,
    h >> 8,
    h & 255,
    w >> 8,
    w & 255,
    1,
    1,
    17,
    0,
    255,
    218,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    255,
    217,
  ]);
export const gpuHeader = (): GpuFrameHeader => ({
  v: 1,
  type: "camera.frame",
  format: "image/jpeg",
  roomId: uuid(1),
  sourceId,
  captureEpoch: epoch,
  frameSeq: 1,
  frameId: `${epoch}:1`,
  sourceTimeMs: 1500,
  sourceWidth: 1280,
  sourceHeight: 720,
  encodedWidth: 640,
  encodedHeight: 360,
  imageLength: markerJpeg().length,
});
describe("GPU v1 bounded transport contracts", () => {
  it("round trips atomic frame identity and JPEG without base64", () => {
    const header = gpuHeader();
    const bytes = encodeGpuFrame(header, markerJpeg());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RLG1");
    expect(decodeGpuFrame(bytes)).toEqual({ header, jpeg: markerJpeg() });
  });
  it.each([
    { v: 2 },
    { frameId: `${epoch}:2` },
    { sourceTimeMs: -1 },
    { sourceTimeMs: Infinity },
    { encodedWidth: 960 },
    { encodedHeight: 0 },
    { sourceWidth: 8192, sourceHeight: 8192 },
    { format: "image/webp" },
    { imageLength: GPU_LIMITS.jpegBytes + 1 },
  ])("rejects malformed metadata %j", (change) => {
    expect(
      GpuFrameHeaderSchema.safeParse({ ...gpuHeader(), ...change }).success,
    ).toBe(false);
  });
  it("rejects unknown fields and worker/viewer role confusion", () => {
    expect(
      GpuHelloSchema.safeParse({
        v: 1,
        type: "gpu.hello",
        role: "viewer",
        roomId: uuid(1),
        token: "a".repeat(43),
      }).success,
    ).toBe(false);
    expect(
      WorkerRegisterSchema.safeParse({
        v: 1,
        type: "worker.register",
        role: "worker",
        workerVersion: "1",
        secret: "a".repeat(43),
        roomId: uuid(1),
      }).success,
    ).toBe(false);
  });
  it("rejects mismatched dimensions and a pixel bomb before decode", () => {
    expect(() => encodeGpuFrame(gpuHeader(), markerJpeg(640, 361))).toThrow();
    expect(() =>
      encodeGpuFrame(gpuHeader(), markerJpeg(16000, 16000)),
    ).toThrow();
  });
  it("rejects corrupt magic, UTF8, header length and oversized messages", () => {
    const bytes = encodeGpuFrame(gpuHeader(), markerJpeg());
    for (const position of [0, 4, 8]) {
      const bad = bytes.slice();
      bad[position] = 255;
      expect(() => decodeGpuFrame(bad)).toThrow();
    }
    expect(() =>
      decodeGpuFrame(new Uint8Array(GPU_LIMITS.messageBytes + 1)),
    ).toThrow();
    expect(() => decodeGpuFrame(bytes.subarray(0, bytes.length - 1))).toThrow();
  });
  it("matches all source-clock and geometry fields, not only frameId", () => {
    const a = gpuHeader();
    expect(sameGpuFrame(a, a)).toBe(true);
    for (const change of [
      { roomId: uuid(2) },
      { sourceTimeMs: 1501 },
      { sourceWidth: 1200 },
      { captureEpoch: uuid(3) },
      { frameSeq: 2 },
    ])
      expect(sameGpuFrame(a, { ...a, ...change })).toBe(false);
  });
  it("accepts only semantic bounded detections and explicit GPU provenance", () => {
    const { format: _format, imageLength: _length, ...identity } = gpuHeader();
    const result = {
      ...identity,
      type: "inference.result",
      modelId: "synthetic-contract",
      modelSha256: "a".repeat(64),
      runtime: "pytorch_cuda",
      inputSize: 640,
      detections: [
        { className: "bus", score: 0.9, bbox: [0.1, 0.2, 0.8, 0.9] },
      ],
      metrics: {
        decodeMs: 1,
        preprocessMs: 2,
        inferenceMs: 3,
        postprocessMs: 1,
        totalMs: 7,
      },
    };
    expect(GpuResultSchema.safeParse(result).success).toBe(true);
    for (const change of [
      { runtime: "cpu" },
      { inputSize: 320 },
      { modelSha256: "unknown" },
      {
        detections: [
          { className: "bus", classId: 5, score: 0.9, bbox: [0, 0, 1, 1] },
        ],
      },
      { metrics: { ...result.metrics, inferenceMs: -1 } },
    ])
      expect(GpuResultSchema.safeParse({ ...result, ...change }).success).toBe(
        false,
      );
  });
});
