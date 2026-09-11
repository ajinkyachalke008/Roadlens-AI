import { z } from "zod";
import { GPU_LIMITS } from "./limits.js";
import { DetectionSchema } from "./schemas.js";
import {
  PlateDescriptorSchema,
  PlateErrorSchema,
  PlateResultSchema,
} from "./plates.js";

const id = z.string().uuid();
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dimension = z.number().int().min(1).max(8192);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const base = { v: z.literal(1) };
export const GpuDescriptorSchema = z
  .object({
    modelId: z.string().min(1).max(160),
    modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runtime: z.enum(["pytorch_cuda", "onnx_cuda", "tensorrt"]),
    inputSize: z.literal(640),
  })
  .strict();
export const GpuHelloSchema = z
  .object({
    ...base,
    type: z.literal("gpu.hello"),
    role: z.literal("camera"),
    roomId: id,
    token,
  })
  .strict();
export const WorkerRegisterSchema = z
  .object({
    ...base,
    type: z.literal("worker.register"),
    role: z.literal("worker"),
    secret: token,
    workerVersion: z.literal("1"),
  })
  .strict();
export const WorkerReadySchema = GpuDescriptorSchema.extend({
  ...base,
  type: z.literal("worker.ready"),
  /**
   * Present only when this worker actually loaded a plate detector and an OCR
   * engine. Its absence is the supported case, not a failure: the traffic
   * pipeline is complete without it.
   */
  plate: PlateDescriptorSchema.optional(),
});
export const GpuIdentitySchema = z
  .object({
    roomId: id,
    sourceId: id,
    captureEpoch: id,
    frameSeq: seq,
    frameId: z.string().max(160),
    sourceTimeMs: time,
    sourceWidth: dimension,
    sourceHeight: dimension,
    encodedWidth: dimension.max(GPU_LIMITS.imageEdge),
    encodedHeight: dimension.max(GPU_LIMITS.imageEdge),
  })
  .strict()
  .refine((f) => f.frameId === `${f.captureEpoch}:${f.frameSeq}`)
  .refine((f) => f.sourceWidth * f.sourceHeight <= 16_777_216)
  .refine(
    (f) => f.encodedWidth <= f.sourceWidth && f.encodedHeight <= f.sourceHeight,
  )
  .refine(
    (f) =>
      Math.abs(
        f.encodedWidth * f.sourceHeight - f.encodedHeight * f.sourceWidth,
      ) <= Math.max(f.sourceWidth, f.sourceHeight),
  );
export const GpuFrameHeaderSchema = GpuIdentitySchema.safeExtend({
  ...base,
  type: z.literal("camera.frame"),
  format: z.literal("image/jpeg"),
  imageLength: z.number().int().min(4).max(GPU_LIMITS.jpegBytes),
});
export const GpuMetricsSchema = z
  .object({
    decodeMs: time.max(60000),
    preprocessMs: time.max(60000),
    inferenceMs: time.max(60000),
    postprocessMs: time.max(60000),
    totalMs: time.max(60000),
  })
  .strict();
export const GpuResultSchema = GpuIdentitySchema.safeExtend({
  ...base,
  type: z.literal("inference.result"),
  ...GpuDescriptorSchema.shape,
  detections: z.array(DetectionSchema).max(100),
  metrics: GpuMetricsSchema,
});
export const GpuErrorSchema = z
  .object({
    ...base,
    type: z.literal("inference.error"),
    roomId: id,
    frameId: z.string().max(160),
    code: z.enum(["decode_failed", "inference_failed", "busy", "timeout"]),
  })
  .strict();
export const GpuStatusSchema = z
  .object({
    ...base,
    type: z.literal("gpu.status"),
    state: z.enum(["ready", "offline", "busy"]),
    descriptor: GpuDescriptorSchema.optional(),
    /** Optional so a relay or worker without plate support stays valid. */
    plate: PlateDescriptorSchema.optional(),
  })
  .strict()
  .refine((s) => s.state !== "ready" || !!s.descriptor);
export const CameraCancelSchema = z
  .object({ ...base, type: z.literal("camera.cancel"), roomId: id })
  .strict();
export const WorkerHeartbeatSchema = z
  .object({ ...base, type: z.literal("worker.heartbeat") })
  .strict();
export const WorkerPongSchema = z
  .object({ ...base, type: z.literal("worker.pong") })
  .strict();
export const WorkerRegisteredSchema = z
  .object({ ...base, type: z.literal("worker.registered"), serverEpoch: id })
  .strict();
export const GpuPingSchema = z
  .object({ ...base, type: z.literal("gpu.ping"), nonce: seq })
  .strict();
export const GpuPongSchema = z
  .object({ ...base, type: z.literal("gpu.pong"), nonce: seq })
  .strict();
export const WorkerMessageSchema = z.union([
  WorkerRegisterSchema,
  WorkerReadySchema,
  WorkerHeartbeatSchema,
  GpuResultSchema,
  GpuErrorSchema,
  PlateResultSchema,
  PlateErrorSchema,
]);
export const GpuServerMessageSchema = z.union([
  GpuStatusSchema,
  GpuResultSchema,
  GpuErrorSchema,
  GpuPongSchema,
  PlateResultSchema,
  PlateErrorSchema,
]);
export type GpuIdentity = z.infer<typeof GpuIdentitySchema>;
export type GpuFrameHeader = z.infer<typeof GpuFrameHeaderSchema>;
export type GpuResult = z.infer<typeof GpuResultSchema>;
export type GpuDescriptor = z.infer<typeof GpuDescriptorSchema>;
export type GpuMetrics = z.infer<typeof GpuMetricsSchema>;

/** Bounded JPEG SOF inspection, before allocating any decoded pixel surface. */
export function gpuJpegDimensions(bytes: Uint8Array) {
  if (
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes.at(-2) !== 255 ||
    bytes.at(-1) !== 217
  )
    throw new Error("Invalid JPEG");
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 255) throw new Error("Invalid JPEG marker");
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 218 || marker === 217) break;
    const size = bytes[offset] * 256 + bytes[offset + 1];
    if (size < 2 || offset + size > bytes.length)
      throw new Error("Invalid JPEG segment");
    if (marker === 192 || marker === 194) {
      if (size < 8 || bytes[offset + 2] !== 8)
        throw new Error("Unsupported JPEG");
      const height = bytes[offset + 3] * 256 + bytes[offset + 4];
      const width = bytes[offset + 5] * 256 + bytes[offset + 6];
      if (!width || !height || Math.max(width, height) > GPU_LIMITS.imageEdge)
        throw new Error("JPEG dimensions exceed limit");
      return { width, height };
    }
    offset += size;
  }
  throw new Error("JPEG dimensions missing");
}
function validateJpeg(header: GpuFrameHeader, jpeg: Uint8Array) {
  if (jpeg.length !== header.imageLength)
    throw new Error("JPEG length mismatch");
  const { width, height } = gpuJpegDimensions(jpeg);
  if (width !== header.encodedWidth || height !== header.encodedHeight)
    throw new Error("JPEG metadata mismatch");
}
export function encodeGpuFrame(raw: GpuFrameHeader, jpeg: Uint8Array) {
  const header = GpuFrameHeaderSchema.parse(raw);
  validateJpeg(header, jpeg);
  const json = new TextEncoder().encode(JSON.stringify(header));
  if (json.length > GPU_LIMITS.headerBytes)
    throw new Error("GPU header too large");
  const bytes = new Uint8Array(8 + json.length + jpeg.length);
  if (bytes.length > GPU_LIMITS.messageBytes)
    throw new Error("GPU frame too large");
  bytes.set([82, 76, 71, 49]);
  new DataView(bytes.buffer).setUint32(4, json.length);
  bytes.set(json, 8);
  bytes.set(jpeg, 8 + json.length);
  return bytes;
}
export function decodeGpuFrame(bytes: Uint8Array) {
  if (
    bytes.length < 12 ||
    bytes.length > GPU_LIMITS.messageBytes ||
    bytes[0] !== 82 ||
    bytes[1] !== 76 ||
    bytes[2] !== 71 ||
    bytes[3] !== 49
  )
    throw new Error("Invalid GPU envelope");
  const size = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(4);
  if (size < 2 || size > GPU_LIMITS.headerBytes || size + 8 >= bytes.length)
    throw new Error("Invalid GPU header");
  const header = GpuFrameHeaderSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(8, 8 + size),
      ),
    ),
  );
  const jpeg = bytes.subarray(8 + size);
  validateJpeg(header, jpeg);
  return { header, jpeg };
}
export function sameGpuFrame(a: GpuIdentity, b: GpuIdentity) {
  return (Object.keys(GpuIdentitySchema.shape) as (keyof GpuIdentity)[]).every(
    (key) => a[key] === b[key],
  );
}
