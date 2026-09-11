export type ClassName =
  "person" | "bicycle" | "car" | "motorcycle" | "bus" | "truck";
export interface Detection {
  className: ClassName;
  score: number;
  bbox: [number, number, number, number];
}
export interface ModelManifest {
  id: string;
  sha256: string;
  bytes: number;
  file: string;
  profile: 416 | 320;
  input: {
    name: string;
    shape: number[];
    dtype: "float32";
    color: "RGB";
    layout: "NCHW";
    normalization: "divide_255";
  };
  output: {
    name: string;
    shape: number[];
    dtype: "float32";
    format: "yolo_e2e_xyxy_score_class" | "yolo_raw_xywh_class_scores";
  };
  classMap: Record<string, ClassName>;
  classCount: number;
  confidence: { low: number; high: number; newTrack: number };
  decoderVersion: string;
  letterbox: {
    padding: number;
    rounding: string;
    resize: string;
    extraPadding: string;
  };
  runtimeVersion: string;
}
export interface Letterbox {
  width: number;
  height: number;
  side: number;
  resizedWidth: number;
  resizedHeight: number;
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
}
export interface DetectionResult {
  detections: Detection[];
  inferenceMs: number;
  modelId: string;
  modelSha256: string;
  profile: 416 | 320 | 640;
  executionProvider: "wasm" | "pytorch_cuda" | "onnx_cuda" | "tensorrt";
}
export interface LoadProgress {
  loaded: number;
  total: number;
  stage: "download" | "initialize";
}
