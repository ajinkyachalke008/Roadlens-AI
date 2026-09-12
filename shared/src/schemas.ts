import { z } from "zod";
import { LIMITS, PLATE_LIMITS } from "./limits.js";
import { PlateTextSchema } from "./plates.js";
export const Classes = [
  "person",
  "bicycle",
  "car",
  "motorcycle",
  "bus",
  "truck",
] as const;
export const ClassSchema = z.enum(Classes);
const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const id = z.string().uuid();
const short = z.string().max(160);
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const BboxSchema = z
  .tuple([
    finite.min(0).max(1),
    finite.min(0).max(1),
    finite.min(0).max(1),
    finite.min(0).max(1),
  ])
  .refine((b) => b[2] > b[0] && b[3] > b[1]);
export const DetectionSchema = z
  .object({
    className: ClassSchema,
    score: finite.min(0).max(1),
    bbox: BboxSchema,
  })
  .strict();
/**
 * Frame-relative motion. It mixes vehicle motion with camera motion and is
 * therefore a direction, never a rate: nothing derived from it is ever
 * presented as a road speed.
 */
export const MotionSchema = z.enum([
  "approaching",
  "receding",
  "left",
  "right",
  "stationary",
  "unknown",
]);
export const TrackSchema = DetectionSchema.extend({
  trackId: seq,
  observed: z.boolean(),
  speedMps: nonnegative.nullable(),
  speedStatus: z.enum(["valid_estimate", "unavailable"]),
  speedReason: short.nullable(),
  ruleState: z.enum(["unmeasured", "normal", "above_limit", "candidate"]),
  /**
   * Added after the tracking pass. Optional as well as present, so a viewer
   * still running a previously cached build keeps parsing frames instead of
   * rejecting the whole session.
   */
  motion: MotionSchema.optional(),
  trackState: z.enum(["tentative", "confirmed", "lost"]).optional(),
  /** Source-time span over which this identity has been observed. */
  observedMs: nonnegative.optional(),
}).refine((t) =>
  t.speedStatus === "valid_estimate"
    ? t.observed && t.speedMps !== null && t.speedReason === null
    : t.speedMps === null && t.speedReason !== null,
);
export const SourceModeSchema = z.enum([
  "live_camera",
  "replay_video",
  "synthetic_test",
]);
export const CountsSchema = z
  .object({
    person: seq,
    bicycle: seq,
    car: seq,
    motorcycle: seq,
    bus: seq,
    truck: seq,
  })
  .strict();
export const FrameSchema = z
  .object({
    v: z.literal(2),
    frameId: short,
    sourceId: id,
    captureEpoch: id,
    frameSeq: seq,
    sourceMode: SourceModeSchema,
    sourceTimeMs: nonnegative,
    capturedAtIso: z.string().datetime(),
    frameWidth: seq.min(1).max(8192),
    frameHeight: seq.min(1).max(8192),
    modelId: short,
    modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
    detectorProfile: short,
    executionProvider: z.enum([
      "wasm",
      "webgpu",
      "pytorch_cuda",
      "onnx_cuda",
      "tensorrt",
    ]),
    trackerVersion: short,
    calibrationVersion: short.nullable(),
    policyVersion: short,
    inferenceMs: nonnegative,
    analysisHz: nonnegative.max(1000),
    tracks: z.array(TrackSchema).max(LIMITS.tracks),
    /**
     * Which operating mode produced this frame. Speed exists only in mounted
     * mode with a valid calibration and a verified stationary background; in
     * every other state `speedActive` is false and the reason says why.
     */
    mode: z
      .object({
        operating: z.enum(["handheld", "mounted"]),
        speedActive: z.boolean(),
        reason: short,
      })
      .strict()
      .optional(),
    /**
     * The vehicle the operator has selected, so a viewer can highlight the same
     * one. Only the identity travels: plate text never rides on a live frame.
     */
    selectedTrackId: seq.nullable().optional(),
    stats: z
      .object({
        counts: CountsSchema,
        crossings: z.object({ forward: seq, reverse: seq }).strict().optional(),
        validSpeedCount: seq.max(100),
        averageSpeedMps: nonnegative.nullable(),
      })
      .strict(),
  })
  .strict()
  .refine((f) => f.frameId === `${f.captureEpoch}:${f.frameSeq}`);
export const PolicySchema = z
  .object({
    version: short,
    roadLabel: z
      .string()
      .max(80)
      .refine(
        (value) => !/[\u0000-\u001f\u007f]/.test(value),
        "Road label cannot contain control characters",
      ),
    speedLimitMps: nonnegative.max(100).nullable(),
    demoMarginMps: nonnegative.max(50),
    limitSource: z.literal("operator_entered_demo"),
  })
  .strict();
export const ReportSchema = z
  .object({
    reportId: id,
    revision: seq,
    sourceId: id,
    captureEpoch: id,
    frameId: short,
    trackId: seq.nullable(),
    sourceMode: SourceModeSchema,
    sourceTimeMs: nonnegative,
    capturedAtIso: z.string().datetime(),
    kind: z.enum(["observation", "speed_candidate", "wrong_way_candidate"]),
    className: ClassSchema.nullable(),
    score: finite.min(0).max(1).nullable(),
    speedMps: nonnegative.nullable(),
    policy: PolicySchema,
    calibrationVersion: short.nullable(),
    modelId: short,
    modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
    detectorProfile: short,
    trackerVersion: short,
    validityReasons: z.array(short).max(8),
    evidenceSummary: z
      .object({
        trajectory: z.array(z.tuple([nonnegative, finite, finite])).max(8),
        residualM: nonnegative.nullable(),
        coverageMs: nonnegative.nullable(),
      })
      .strict(),
    /**
     * Plate fields are optional as well as nullable. A camera that never ran
     * plate recognition omits them entirely, so its reports are byte identical
     * to those a build without this feature produced, and an older viewer's
     * strict schema still accepts them.
     */
    plateStatus: z
      .enum(["unavailable", "pending", "unreadable", "read"])
      .optional(),
    plateText: PlateTextSchema.nullable().optional(),
    plateConfidence: finite.min(0).max(1).nullable().optional(),
    plateSupportingFrames: seq.max(PLATE_LIMITS.adaptiveFrames).optional(),
    plateDetectorConfidence: finite.min(0).max(1).nullable().optional(),
    /** A strong single-frame OCR observation is review context, not a result. */
    plateCandidateText: PlateTextSchema.nullable().optional(),
    plateCandidateConfidence: finite.min(0).max(1).nullable().optional(),
    plateCandidateSupportingFrames: seq
      .max(PLATE_LIMITS.adaptiveFrames)
      .optional(),
    plateAttemptFrames: seq.max(PLATE_LIMITS.adaptiveFrames).optional(),
    plateLocalizedFrames: seq.max(PLATE_LIMITS.adaptiveFrames).optional(),
    plateReadableFrames: seq.max(PLATE_LIMITS.adaptiveFrames).optional(),
    /**
     * Improving review artifacts are intentionally distinct from immutable
     * event evidence. Their pixels still live only in the camera/viewer RAM.
     */
    bestCapture: z
      .object({
        imageId: id,
        state: z.enum(["available", "evicted"]),
        frameId: short,
        sourceTimeMs: nonnegative,
        width: seq.min(1).max(8192),
        height: seq.min(1).max(8192),
        quality: finite.min(0).max(1),
        sharpness: nonnegative,
      })
      .strict()
      .optional(),
    bestPlateDetail: z
      .object({
        imageId: id,
        state: z.enum(["available", "evicted"]),
        frameId: short,
        sourceTimeMs: nonnegative,
        width: seq.min(1).max(8192),
        height: seq.min(1).max(8192),
        quality: finite.min(0).max(1),
        sharpness: nonnegative,
      })
      .strict()
      .optional(),
    /** Later qualifying frame when an immutable Showcase event is promoted. */
    measurementFrameId: short.optional(),
    measurementSourceTimeMs: nonnegative.optional(),
    evidenceId: id.nullable(),
    evidenceState: z.enum(["none", "available", "evicted"]),
    review: z.enum(["pending", "noted", "dismissed"]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .refine((r) => new TextEncoder().encode(JSON.stringify(r)).length <= 2048)
  .refine(
    (r) =>
      r.frameId.startsWith(r.captureEpoch + ":") &&
      /^(0|[1-9][0-9]*)$/.test(r.frameId.slice(r.captureEpoch.length + 1)) &&
      Number.isSafeInteger(Number(r.frameId.slice(r.captureEpoch.length + 1))),
  )
  .refine(
    // A readable plate must carry its confidence and the frames that agreed;
    // any other status must not carry text at all.
    (r) =>
      r.plateStatus === "read"
        ? typeof r.plateText === "string" &&
          typeof r.plateConfidence === "number" &&
          (r.plateSupportingFrames ?? 0) >= PLATE_LIMITS.minSupportingFrames
        : r.plateText === null || r.plateText === undefined,
  )
  .refine((r) => r.plateStatus !== undefined || r.plateText === undefined)
  .refine(
    (r) =>
      r.plateStatus !== "read" ||
      r.plateCandidateText === null ||
      r.plateCandidateText === undefined,
  )
  .refine((r) =>
    typeof r.plateCandidateText === "string"
      ? typeof r.plateCandidateConfidence === "number" &&
        (r.plateCandidateSupportingFrames ?? 0) >= 1
      : r.plateCandidateConfidence === null ||
        r.plateCandidateConfidence === undefined,
  )
  .refine(
    (r) =>
      (r.measurementFrameId === undefined) ===
      (r.measurementSourceTimeMs === undefined),
  )
  .refine(
    (r) =>
      r.measurementFrameId === undefined ||
      r.measurementFrameId.startsWith(r.captureEpoch + ":"),
  )
  .refine(
    (r) =>
      r.kind !== "speed_candidate" ||
      (r.speedMps !== null &&
        r.calibrationVersion !== null &&
        r.trackId !== null &&
        r.validityReasons.length === 0),
  );
const base = { v: z.literal(2) };
const req = { requestId: id };
export const HelloSchema = z
  .object({
    ...base,
    type: z.literal("hello"),
    roomId: id,
    role: z.enum(["camera", "viewer"]),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export const ControlSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("camera.status"),
      state: z.enum(["live", "paused", "model-loading", "offline"]),
      captureEpoch: id.nullable(),
      sourceMode: SourceModeSchema,
      analysisHz: nonnegative.max(1000),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("session.update"),
      policy: PolicySchema,
      calibrationStatus: short,
    })
    .strict(),
  z
    .object({ ...base, type: z.literal("report.upsert"), report: ReportSchema })
    .strict(),
  z.object({ ...base, ...req, type: z.literal("state.request") }).strict(),
  z
    .object({
      ...base,
      ...req,
      type: z.literal("state.snapshot"),
      reports: z.array(ReportSchema).max(10),
      done: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...base,
      ...req,
      type: z.literal("evidence.request"),
      evidenceId: id,
    })
    .strict(),
  z
    .object({
      ...base,
      ...req,
      type: z.literal("review.request"),
      reportId: id,
      expectedRevision: seq,
      review: z.enum(["pending", "noted", "dismissed"]),
    })
    .strict(),
  z
    .object({
      ...base,
      ...req,
      type: z.literal("review.result"),
      accepted: z.boolean(),
      code: z.enum(["ok", "revision_conflict", "report_unavailable"]),
    })
    .strict(),
  z.object({ ...base, type: z.literal("ping") }).strict(),
  z.object({ ...base, type: z.literal("pong") }).strict(),
  z
    .object({
      ...base,
      type: z.literal("error"),
      code: short,
      message: short,
      requestId: id.optional(),
      retryAfterMs: nonnegative.optional(),
    })
    .strict(),
]);
const imageFields = {
  ...base,
  imageWidth: seq.min(1).max(LIMITS.imageEdge),
  imageHeight: seq.min(1).max(LIMITS.imageEdge),
  imageLength: seq.min(4).max(LIMITS.jpegBytes),
};
export const PacketHeaderSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...imageFields,
      type: z.literal("analysis.frame"),
      frameId: short,
      result: FrameSchema,
    })
    .strict()
    .refine((h) => h.frameId === h.result.frameId),
  z
    .object({
      ...imageFields,
      ...req,
      type: z.literal("evidence.frame"),
      evidenceId: id,
    })
    .strict(),
]);
export type Detection = z.infer<typeof DetectionSchema>;
export type FrameResult = z.infer<typeof FrameSchema>;
export type TrackView = z.infer<typeof TrackSchema>;
export type Report = z.infer<typeof ReportSchema>;
export type CameraPolicy = z.infer<typeof PolicySchema>;
export type Control = z.infer<typeof ControlSchema>;
export type PacketHeader = z.infer<typeof PacketHeaderSchema>;
export type SemanticClass = z.infer<typeof ClassSchema>;
export const emptyCounts = () => ({
  person: 0,
  bicycle: 0,
  car: 0,
  motorcycle: 0,
  bus: 0,
  truck: 0,
});
