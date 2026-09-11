import { invertBox } from "./preprocess";
import type { Detection, Letterbox, ModelManifest } from "./types";
export function iou(a: number[], b: number[]) {
  const intersection =
    Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!)) *
    Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!));
  return (
    intersection /
    ((a[2]! - a[0]!) * (a[3]! - a[1]!) +
      (b[2]! - b[0]!) * (b[3]! - b[1]!) -
      intersection || 1)
  );
}
export function decode(
  data: Float32Array,
  dims: readonly number[],
  manifest: ModelManifest,
  info: Letterbox,
): Detection[] {
  if (
    JSON.stringify(dims) !== JSON.stringify(manifest.output.shape) ||
    data.length !== dims.reduce((a, b) => a * b, 1)
  )
    throw new Error("Model output shape does not match manifest");
  const detections: Detection[] = [];
  const add = (box: number[], score: number, classId: number) => {
    const className = manifest.classMap[String(classId)];
    if (
      !Number.isFinite(score) ||
      score < manifest.confidence.low ||
      score > 1 ||
      !Number.isInteger(classId) ||
      !className
    )
      return;
    const bbox = invertBox(box, info);
    if (bbox) detections.push({ className, score, bbox });
  };
  if (manifest.output.format === "yolo_e2e_xyxy_score_class") {
    if (dims.length !== 3 || dims[0] !== 1 || dims[2] !== 6)
      throw new Error("Invalid e2e output");
    for (let i = 0; i < data.length; i += 6)
      add(Array.from(data.subarray(i, i + 4)), data[i + 4]!, data[i + 5]!);
  } else if (manifest.output.format === "yolo_raw_xywh_class_scores") {
    if (
      dims.length !== 3 ||
      dims[0] !== 1 ||
      dims[1] !== manifest.classCount + 4
    )
      throw new Error("Invalid raw output");
    const n = dims[2]!;
    for (let i = 0; i < n; i++) {
      let score = 0,
        cls = -1;
      for (let c = 0; c < manifest.classCount; c++)
        if (data[(c + 4) * n + i]! > score) {
          score = data[(c + 4) * n + i]!;
          cls = c;
        }
      const x = data[i]!,
        y = data[n + i]!,
        w = data[2 * n + i]!,
        h = data[3 * n + i]!;
      add([x - w / 2, y - h / 2, x + w / 2, y + h / 2], score, cls);
    }
  } else throw new Error("Unknown model output format");
  detections.sort((a, b) => b.score - a.score);
  const selected: Detection[] = [];
  for (const det of detections) {
    if (
      manifest.output.format === "yolo_raw_xywh_class_scores" &&
      selected.some(
        (s) => s.className === det.className && iou(s.bbox, det.bbox) > 0.45,
      )
    )
      continue;
    selected.push(det);
    if (selected.length === 100) break;
  }
  return selected;
}
