import { describe, expect, it, vi } from "vitest";
import { AutoPlateScanner } from "../../frontend/src/plates/autoScanner";
import { newPolicy, type CompletedFrame } from "../../frontend/src/camera/capture";
import type { TrackView, FrameResult } from "../../shared/src/schemas";

// Mock scanIndianPlateFromCanvas
vi.mock("../../frontend/src/plates/indianPlateScanner", () => ({
  scanIndianPlateFromCanvas: vi.fn().mockImplementation(async (_canvas, _bbox) => {
    return {
      success: true,
      text: "MH12AB1234",
      confidence: 0.95,
      plate: {
        raw: "MH12AB1234",
        cleaned: "MH12AB1234",
        formatted: "MH 12 AB 1234",
        stateCode: "MH",
        stateName: "Maharashtra",
        districtCode: "12",
        rtoLocation: "Pune",
        series: "AB",
        uniqueNumber: "1234",
        isBharatSeries: false,
        isValid: true,
      },
    };
  }),
}));

function makeTrack(over: {
  trackId: number;
  className: "car" | "truck" | "person";
  bbox: [number, number, number, number];
  speedMps?: number | null;
  ruleState?: "normal" | "candidate" | "above_limit";
  score?: number;
}): TrackView {
  const speed = over.speedMps ?? null;
  return {
    trackId: over.trackId,
    className: over.className,
    score: over.score ?? 0.9,
    bbox: over.bbox,
    observed: true,
    ruleState: over.ruleState ?? "normal",
    speedMps: speed,
    speedStatus: speed !== null ? "valid_estimate" : "unavailable",
    speedReason: speed !== null ? null : "insufficient_samples",
  };
}

function makeMockFrame(tracks: TrackView[], speedLimitMps: number | null = 13.4): CompletedFrame {
  const policy = {
    ...newPolicy(),
    speedLimitMps,
    roadLabel: "Test Highway",
  };

  const result: FrameResult = {
    v: 2,
    sourceId: "src-1",
    captureEpoch: "epoch-1",
    modelId: "yolo-v8",
    modelSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    detectorProfile: "standard",
    capturedAtIso: new Date().toISOString(),
    trackerVersion: "v1",
    calibrationVersion: null,
    policyVersion: "v1",
    inferenceMs: 12,
    analysisHz: 30,
    frameId: "epoch-1:1",
    frameSeq: 1,
    sourceTimeMs: 1000,
    tracks,
    stats: {
      counts: { person: 0, bicycle: 0, car: 0, motorcycle: 0, bus: 0, truck: 0 },
      validSpeedCount: 0,
      averageSpeedMps: null,
    },
    frameWidth: 1280,
    frameHeight: 720,
    executionProvider: "webgpu",
    sourceMode: "live_camera",
  };

  return {
    canvas: { width: 1280, height: 720 } as unknown as HTMLCanvasElement,
    result,
    policy,
    candidates: [],
    estimates: new Map(),
    ambiguousTrackIds: new Set(),
    jpeg: new Blob(),
    jpegWidth: 1280,
    jpegHeight: 720,
    processingMs: 15,
  };
}

describe("AutoPlateScanner", () => {
  it("starts disabled and does not scan when disabled", async () => {
    const scanner = new AutoPlateScanner();
    scanner.minIntervalMs = 0;
    expect(scanner.enabled).toBe(false);
    expect(scanner.scannedCount).toBe(0);

    const track = makeTrack({
      trackId: 1,
      className: "car",
      bbox: [0.2, 0.2, 0.6, 0.6],
      speedMps: 10,
    });

    const detected = vi.fn();
    scanner.onPlateDetected = detected;

    await scanner.processFrame(makeMockFrame([track]));
    expect(detected).not.toHaveBeenCalled();
    expect(scanner.scannedCount).toBe(0);
  });

  it("scans passing vehicle and triggers onPlateDetected in hands-free mode", async () => {
    const scanner = new AutoPlateScanner();
    scanner.minIntervalMs = 0;
    scanner.enabled = true;

    const track = makeTrack({
      trackId: 10,
      className: "car",
      bbox: [0.2, 0.2, 0.6, 0.6],
      speedMps: 12,
    });

    const detected = vi.fn();
    scanner.onPlateDetected = detected;

    await scanner.processFrame(makeMockFrame([track]));

    expect(detected).toHaveBeenCalledTimes(1);
    expect(detected.mock.calls[0][0].track.trackId).toBe(10);
    expect(detected.mock.calls[0][0].scanResult.plate?.formatted).toBe("MH 12 AB 1234");
    expect(scanner.scannedCount).toBe(1);
    expect(scanner.isTrackScanned(10)).toBe(true);

    // Deduplication: second pass for same track does not trigger again
    await scanner.processFrame(makeMockFrame([track]));
    expect(detected).toHaveBeenCalledTimes(1);
  });

  it("skips non-vehicles like pedestrians", async () => {
    const scanner = new AutoPlateScanner();
    scanner.minIntervalMs = 0;
    scanner.enabled = true;

    const track = makeTrack({
      trackId: 5,
      className: "person",
      bbox: [0.2, 0.2, 0.6, 0.6],
      speedMps: 1.5,
    });

    const detected = vi.fn();
    scanner.onPlateDetected = detected;

    await scanner.processFrame(makeMockFrame([track]));
    expect(detected).not.toHaveBeenCalled();
    expect(scanner.scannedCount).toBe(0);
  });

  it("skips tiny vehicles that are too far away", async () => {
    const scanner = new AutoPlateScanner();
    scanner.minIntervalMs = 0;
    scanner.enabled = true;

    const track = makeTrack({
      trackId: 7,
      className: "car",
      bbox: [0.1, 0.1, 0.12, 0.12], // tiny in frame (~25x14 px)
      speedMps: 10,
    });

    const detected = vi.fn();
    scanner.onPlateDetected = detected;

    await scanner.processFrame(makeMockFrame([track]));
    expect(detected).not.toHaveBeenCalled();
    expect(scanner.scannedCount).toBe(0);
  });

  it("respects speed_only trigger mode", async () => {
    const scanner = new AutoPlateScanner();
    scanner.minIntervalMs = 0;
    scanner.enabled = true;
    scanner.triggerMode = "speed_only";

    const legalTrack = makeTrack({
      trackId: 21,
      className: "car",
      bbox: [0.2, 0.2, 0.6, 0.6],
      speedMps: 10, // below limit 13.4
    });

    const speedingTrack = makeTrack({
      trackId: 22,
      className: "truck",
      bbox: [0.2, 0.2, 0.6, 0.6],
      ruleState: "above_limit",
      speedMps: 20, // above limit 13.4
    });

    const detected = vi.fn();
    scanner.onPlateDetected = detected;

    // First frame with legal vehicle
    await scanner.processFrame(makeMockFrame([legalTrack]));
    expect(detected).not.toHaveBeenCalled();

    // Second frame with speeding vehicle
    await scanner.processFrame(makeMockFrame([speedingTrack]));
    expect(detected).toHaveBeenCalledTimes(1);
    expect(detected.mock.calls[0][0].track.trackId).toBe(22);
  });

  it("resets state when reset() is invoked", async () => {
    const scanner = new AutoPlateScanner();
    scanner.minIntervalMs = 0;
    scanner.enabled = true;

    const track = makeTrack({
      trackId: 30,
      className: "car",
      bbox: [0.2, 0.2, 0.6, 0.6],
      speedMps: 10,
    });

    await scanner.processFrame(makeMockFrame([track]));
    expect(scanner.scannedCount).toBe(1);

    scanner.reset();
    expect(scanner.scannedCount).toBe(0);
    expect(scanner.isTrackScanned(30)).toBe(false);
  });
});
