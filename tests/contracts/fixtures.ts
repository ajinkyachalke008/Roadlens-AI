import {
  emptyCounts,
  type FrameResult,
  type CameraPolicy,
  type Report,
} from "../../shared/src/schemas";
// Explicit synthetic metadata for contract/unit tests. Marker JPEGs test envelopes, not image inference.
export const sourceId = "11111111-1111-4111-8111-111111111111";
export const epoch = "22222222-2222-4222-8222-222222222222";
export const uuid = (index: number) =>
  `33333333-3333-4333-8333-${index.toString().padStart(12, "0")}`;
export const policy = (): CameraPolicy => ({
  version: "synthetic-policy",
  roadLabel: "Synthetic test road",
  speedLimitMps: 10,
  demoMarginMps: 2,
  limitSource: "operator_entered_demo",
});
export function frame(seq = 1): FrameResult {
  return {
    v: 2,
    frameId: `${epoch}:${seq}`,
    sourceId,
    captureEpoch: epoch,
    frameSeq: seq,
    sourceMode: "synthetic_test",
    sourceTimeMs: seq * 200,
    capturedAtIso: "2026-09-10T12:00:00.000Z",
    frameWidth: 1280,
    frameHeight: 720,
    modelId: "synthetic-contract-only",
    modelSha256: "a".repeat(64),
    detectorProfile: "416",
    executionProvider: "wasm",
    trackerVersion: "time_aware_iou_v1",
    calibrationVersion: null,
    policyVersion: "synthetic-policy",
    inferenceMs: 50,
    analysisHz: 5,
    tracks: [
      {
        trackId: 1,
        className: "car",
        score: 0.8,
        bbox: [0.2, 0.2, 0.4, 0.5],
        observed: true,
        speedMps: null,
        speedStatus: "unavailable",
        speedReason: "not_calibrated",
        ruleState: "unmeasured",
      },
    ],
    stats: {
      counts: { ...emptyCounts(), car: 1 },
      validSpeedCount: 0,
      averageSpeedMps: null,
    },
  };
}
export function report(index = 1): Report {
  const f = frame(index);
  return {
    reportId: uuid(index),
    revision: 0,
    sourceId,
    captureEpoch: epoch,
    frameId: f.frameId,
    trackId: 1,
    sourceMode: "synthetic_test",
    sourceTimeMs: f.sourceTimeMs,
    capturedAtIso: f.capturedAtIso,
    kind: "observation",
    className: "car",
    score: 0.8,
    speedMps: null,
    policy: policy(),
    calibrationVersion: null,
    modelId: f.modelId,
    modelSha256: f.modelSha256,
    detectorProfile: f.detectorProfile,
    trackerVersion: f.trackerVersion,
    validityReasons: ["not_calibrated"],
    evidenceSummary: { trajectory: [], residualM: null, coverageMs: null },
    evidenceId: null,
    evidenceState: "none",
    review: "pending",
    createdAt: f.capturedAtIso,
    updatedAt: f.capturedAtIso,
  };
}
export const markerJpeg = (size = 4) => {
  const bytes = new Uint8Array(size);
  bytes.set([255, 216]);
  bytes.set([255, 217], size - 2);
  return bytes;
};
