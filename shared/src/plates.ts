import { z } from "zod";
import { PLATE_LIMITS } from "./limits.js";

/**
 * Plate transport, deliberately separate from `camera.frame`/`inference.result`.
 *
 * Two properties matter more than anything else here. First, a plate request
 * carries a *vehicle crop taken from the full resolution source frame*, not the
 * downscaled analysis frame, because a plate is only a few dozen pixels wide in
 * a 640 px analysis image and no amount of processing recovers what was never
 * sampled. Second, the exchange is asynchronous and correlated by an explicit
 * `requestId`: a plate round trip may outlive several analysis frames, and it
 * must never hold one up.
 *
 * Results are single frame observations. Consensus across frames belongs to the
 * camera, which is the only party that holds track state — so the worker keeps
 * no plate text at all, not even for the duration of a session.
 */
const id = z.string().uuid();
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dimension = z.number().int().min(1).max(8192);
const unit = z.number().finite().min(0).max(1);
const base = { v: z.literal(1) };
/**
 * Characters a plate reading may contain. Digits, Latin capitals and the two
 * separators that appear on real North American plates. Anything else is a
 * misread of a slogan, a frame or a bumper sticker rather than a plate.
 */
export const PLATE_TEXT = /^[A-Z0-9][A-Z0-9 -]{0,16}[A-Z0-9]$/;
export const PlateTextSchema = z
  .string()
  .min(PLATE_LIMITS.minTextLength)
  .max(PLATE_LIMITS.maxTextLength)
  .regex(PLATE_TEXT);
export const PlateDescriptorSchema = z
  .object({
    detectorId: z.string().min(1).max(160),
    detectorSha256: z.string().regex(/^[a-f0-9]{64}$/),
    ocrEngine: z.string().min(1).max(80),
    inputSize: z.number().int().min(128).max(1280),
  })
  .strict();
export const PlateIdentitySchema = z
  .object({
    roomId: id,
    sourceId: id,
    captureEpoch: id,
    /** Unique per request; the only key results are correlated by. */
    requestId: id,
    frameSeq: seq,
    frameId: z.string().max(160),
    trackId: seq,
    sourceTimeMs: time,
  })
  .strict()
  .refine((f) => f.frameId === `${f.captureEpoch}:${f.frameSeq}`);
export const PlateFrameHeaderSchema = PlateIdentitySchema.safeExtend({
  ...base,
  type: z.literal("camera.plate"),
  format: z.literal("image/jpeg"),
  sourceWidth: dimension,
  sourceHeight: dimension,
  /** The crop's placement inside the source frame, normalised. */
  cropX: unit,
  cropY: unit,
  cropWidth: unit,
  cropHeight: unit,
  encodedWidth: dimension.max(PLATE_LIMITS.cropEdge),
  encodedHeight: dimension.max(PLATE_LIMITS.cropEdge),
  imageLength: z.number().int().min(4).max(PLATE_LIMITS.jpegBytes),
})
  .refine((f) => f.cropX + f.cropWidth <= 1 && f.cropY + f.cropHeight <= 1)
  .refine((f) => f.cropWidth > 0 && f.cropHeight > 0)
  .refine(
    (f) =>
      Math.max(f.encodedWidth, f.encodedHeight) >= PLATE_LIMITS.minCropEdge,
  );
export const PlateMetricsSchema = z
  .object({
    decodeMs: time.max(60000),
    detectMs: time.max(60000),
    ocrMs: time.max(60000),
    totalMs: time.max(60000),
  })
  .strict();
/**
 * A result with `plateText: null` is a successful, honest observation: the
 * worker looked and could not read a plate. It is not an error, and the camera
 * counts it as evidence against a weak consensus rather than discarding it.
 */
export const PlateResultSchema = PlateIdentitySchema.safeExtend({
  ...base,
  type: z.literal("plate.result"),
  ...PlateDescriptorSchema.shape,
  plateText: PlateTextSchema.nullable(),
  plateConfidence: z.number().finite().min(0).max(1).nullable(),
  detectorConfidence: z.number().finite().min(0).max(1).nullable(),
  /** Plate box within the submitted crop, normalised. */
  plateBox: z.tuple([unit, unit, unit, unit]).nullable(),
  metrics: PlateMetricsSchema,
})
  .refine((r) => (r.plateText === null) === (r.plateConfidence === null))
  .refine((r) => r.plateBox === null || (r.plateBox[2] > r.plateBox[0] && r.plateBox[3] > r.plateBox[1]));
export const PlateErrorSchema = z
  .object({
    ...base,
    type: z.literal("plate.error"),
    roomId: id,
    requestId: id,
    code: z.enum([
      "decode_failed",
      "plate_failed",
      "busy",
      "timeout",
      "unavailable",
    ]),
  })
  .strict();
export type PlateDescriptor = z.infer<typeof PlateDescriptorSchema>;
export type PlateIdentity = z.infer<typeof PlateIdentitySchema>;
export type PlateFrameHeader = z.infer<typeof PlateFrameHeaderSchema>;
export type PlateResult = z.infer<typeof PlateResultSchema>;
export type PlateError = z.infer<typeof PlateErrorSchema>;

function validateJpeg(header: PlateFrameHeader, jpeg: Uint8Array) {
  if (jpeg.length !== header.imageLength)
    throw new Error("Plate JPEG length mismatch");
  if (
    jpeg[0] !== 255 ||
    jpeg[1] !== 216 ||
    jpeg.at(-2) !== 255 ||
    jpeg.at(-1) !== 217
  )
    throw new Error("Invalid plate JPEG");
}
/** `RLP1` keeps plate crops distinguishable from `RLG1` analysis frames. */
const MAGIC = [82, 76, 80, 49];
export function encodePlateFrame(raw: PlateFrameHeader, jpeg: Uint8Array) {
  const header = PlateFrameHeaderSchema.parse(raw);
  validateJpeg(header, jpeg);
  const json = new TextEncoder().encode(JSON.stringify(header));
  if (json.length > PLATE_LIMITS.headerBytes)
    throw new Error("Plate header too large");
  const bytes = new Uint8Array(8 + json.length + jpeg.length);
  if (bytes.length > PLATE_LIMITS.messageBytes)
    throw new Error("Plate frame too large");
  bytes.set(MAGIC);
  new DataView(bytes.buffer).setUint32(4, json.length);
  bytes.set(json, 8);
  bytes.set(jpeg, 8 + json.length);
  return bytes;
}
export function isPlateFrame(bytes: Uint8Array) {
  return MAGIC.every((value, index) => bytes[index] === value);
}
export function decodePlateFrame(bytes: Uint8Array) {
  if (
    bytes.length < 12 ||
    bytes.length > PLATE_LIMITS.messageBytes ||
    !isPlateFrame(bytes)
  )
    throw new Error("Invalid plate envelope");
  const size = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(4);
  if (size < 2 || size > PLATE_LIMITS.headerBytes || size + 8 >= bytes.length)
    throw new Error("Invalid plate header");
  const header = PlateFrameHeaderSchema.parse(
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
/** Exact identity match; a plate result is never attributed by arrival order. */
export function samePlateRequest(a: PlateIdentity, b: PlateIdentity) {
  return (
    Object.keys(PlateIdentitySchema.shape) as (keyof PlateIdentity)[]
  ).every((key) => a[key] === b[key]);
}
