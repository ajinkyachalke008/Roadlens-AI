import {
  SHOWCASE_ARMING_MS,
  ShowcaseController,
  showcaseReadiness,
  type ShowcaseQuality,
} from "../frontend/src/showcase/controller";
import {
  emptyCounts,
  type FrameResult,
  type TrackView,
} from "../shared/src/schemas";

const epoch = "22222222-2222-4222-8222-222222222222";
const vehicle = (
  bbox: readonly [number, number, number, number],
): TrackView => ({
  trackId: 7,
  className: "car",
  score: 0.9,
  bbox,
  observed: true,
  speedMps: null,
  speedStatus: "unavailable",
  speedReason: "handheld",
  ruleState: "unmeasured",
  trackState: "confirmed",
  observedMs: 1_000,
});
const frame = (
  sourceTimeMs: number,
  track: TrackView,
  frameWidth = 1920,
  frameHeight = 1080,
): FrameResult => ({
  v: 2,
  frameId: `${epoch}:${Math.round(sourceTimeMs)}`,
  sourceId: "11111111-1111-4111-8111-111111111111",
  captureEpoch: epoch,
  frameSeq: Math.max(0, Math.round(sourceTimeMs)),
  sourceMode: "synthetic_test",
  sourceTimeMs,
  capturedAtIso: "2026-09-12T00:00:00.000Z",
  frameWidth,
  frameHeight,
  modelId: "benchmark-only",
  modelSha256: "a".repeat(64),
  detectorProfile: "416",
  executionProvider: "wasm",
  trackerVersion: "time_aware_iou_v1",
  calibrationVersion: null,
  policyVersion: "benchmark-policy",
  inferenceMs: 0,
  analysisHz: 10,
  tracks: [track],
  stats: {
    counts: { ...emptyCounts(), car: 1 },
    validSpeedCount: 0,
    averageSpeedMps: null,
  },
});

const looks: Array<{
  label: string;
  bbox: readonly [number, number, number, number];
  measured: ShowcaseQuality;
}> = [
  {
    label: "small",
    bbox: [0.44, 0.4, 0.56, 0.54],
    measured: { sharpness: 3, quality: 0.35 },
  },
  {
    label: "medium",
    bbox: [0.39, 0.35, 0.61, 0.61],
    measured: { sharpness: 4, quality: 0.45 },
  },
  {
    label: "large_sharp",
    bbox: [0.2, 0.16, 0.8, 0.82],
    measured: { sharpness: 20, quality: 0.9 },
  },
];

const readiness = looks.map((look) => {
  const track = vehicle(look.bbox);
  return {
    label: look.label,
    at720p: showcaseReadiness(track, frame(0, track, 1280, 720), look.measured),
    at1080p: showcaseReadiness(track, frame(0, track), look.measured),
  };
});

const controller = new ShowcaseController();
controller.setEnabled(true);
controller.onFrame(frame(0, vehicle(looks[0]!.bbox)));
const phases: Array<{
  sourceTimeMs: number;
  phase: string;
  readiness: number;
}> = [];
const timeline = [
  { sourceTimeMs: SHOWCASE_ARMING_MS, look: looks[0]! },
  { sourceTimeMs: SHOWCASE_ARMING_MS + 600, look: looks[1]! },
  { sourceTimeMs: SHOWCASE_ARMING_MS + 900, look: looks[1]! },
  { sourceTimeMs: SHOWCASE_ARMING_MS + 1_500, look: looks[2]! },
];
for (const { sourceTimeMs, look } of timeline) {
  const track = vehicle(look.bbox);
  controller.onFrame(
    frame(sourceTimeMs, track),
    new Set(),
    new Map([[track.trackId, look.measured]]),
  );
  const state = controller.snapshot();
  phases.push({
    sourceTimeMs,
    phase: state.phase,
    readiness: state.currentReadiness || state.targetBestReadiness,
  });
}

const iterations = 100_000;
const started = performance.now();
for (let index = 0; index < iterations; index++) {
  const look = looks[index % looks.length]!;
  const track = vehicle(look.bbox);
  showcaseReadiness(track, frame(index, track), look.measured);
}
const elapsedMs = performance.now() - started;

process.stdout.write(
  JSON.stringify(
    {
      benchmark: "adaptive-showcase-readiness-v1",
      generatedAt: new Date().toISOString(),
      thresholds: {
        minimumArmingMs: SHOWCASE_ARMING_MS,
        candidates: looks.length,
      },
      readiness,
      phases,
      compute: {
        iterations,
        elapsedMs,
        microsecondsPerScore: (elapsedMs * 1000) / iterations,
      },
      scope:
        "Deterministic synthetic geometry and quality-signal benchmark; not physical plate-read validation.",
    },
    null,
    2,
  ) + "\n",
);
