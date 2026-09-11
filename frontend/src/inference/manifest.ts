import type { ModelManifest } from "./types";
const classes = new Set([
  "person",
  "bicycle",
  "car",
  "motorcycle",
  "bus",
  "truck",
]);
export function validateManifest(value: unknown): ModelManifest {
  const m = value as ModelManifest;
  if (
    !m ||
    ![320, 416].includes(m.profile) ||
    !/^[\da-f]{64}$/.test(m.sha256) ||
    !Number.isInteger(m.bytes) ||
    m.bytes < 1000 ||
    m.bytes > 32 * 1024 * 1024 ||
    !/^[-\w]+\.onnx$/.test(m.file) ||
    typeof m.id !== "string"
  )
    throw new Error("Invalid model manifest");
  if (
    m.input?.dtype !== "float32" ||
    m.input.color !== "RGB" ||
    m.input.layout !== "NCHW" ||
    m.input.normalization !== "divide_255" ||
    JSON.stringify(m.input.shape) !==
      JSON.stringify([1, 3, m.profile, m.profile])
  )
    throw new Error("Unsupported model input");
  if (
    m.decoderVersion !== "roadlens_decode_v1" ||
    m.letterbox?.padding !== 114 ||
    m.letterbox.rounding !== "half_up" ||
    m.letterbox.resize !== "pixel_center_bilinear_no_antialias" ||
    m.letterbox.extraPadding !== "bottom_right"
  )
    throw new Error("Unsupported model preprocessing or decoder version");
  if (
    !m.output ||
    m.output.dtype !== "float32" ||
    !["yolo_e2e_xyxy_score_class", "yolo_raw_xywh_class_scores"].includes(
      m.output.format,
    ) ||
    !Array.isArray(m.output.shape) ||
    !m.output.shape.every((n) => Number.isInteger(n) && n > 0) ||
    m.output.shape.reduce((a, b) => a * b, 1) > 1000000
  )
    throw new Error("Unsupported model output");
  if (
    m.output.shape.length !== 3 ||
    m.output.shape[0] !== 1 ||
    (m.output.format === "yolo_e2e_xyxy_score_class"
      ? m.output.shape[2] !== 6
      : m.output.shape[1] !== m.classCount + 4)
  )
    throw new Error("Unsupported model output shape");
  if (
    !Number.isInteger(m.classCount) ||
    m.classCount < 6 ||
    m.classCount > 100 ||
    !m.classMap ||
    Object.entries(m.classMap).some(
      ([k, v]) =>
        !/^\d+$/.test(k) || Number(k) >= m.classCount || !classes.has(v),
    ) ||
    new Set(Object.values(m.classMap)).size !== 6
  )
    throw new Error("Invalid model semantic class map");
  if (
    !m.confidence ||
    ![m.confidence.low, m.confidence.high, m.confidence.newTrack].every(
      (v) => Number.isFinite(v) && v >= 0 && v <= 1,
    )
  )
    throw new Error("Invalid model confidence policy");
  if (
    m.confidence.low > m.confidence.high ||
    m.confidence.high > m.confidence.newTrack
  )
    throw new Error("Invalid confidence threshold ordering");
  return m;
}
export async function verifyIntegrity(
  bytes: ArrayBuffer,
  manifest: Pick<ModelManifest, "bytes" | "sha256">,
) {
  if (bytes.byteLength !== manifest.bytes)
    throw new Error("Model byte length mismatch");
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== manifest.sha256) throw new Error("Model integrity mismatch");
}
