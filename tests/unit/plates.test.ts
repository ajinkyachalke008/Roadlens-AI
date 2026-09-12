import { beforeEach, describe, expect, it } from "vitest";
import { PLATE_LIMITS } from "../../shared/src/limits";
import {
  plateConsensus,
  shapeKey,
  type PlateObservation,
} from "../../frontend/src/plates/consensus";
import { cropQuality } from "../../frontend/src/plates/quality";
import { plateFields } from "../../frontend/src/plates/report";
import { PlateCapture } from "../../frontend/src/plates/capture";
import { PlateUnavailableError } from "../../frontend/src/inference/remote";
import type {
  PlateRequest,
  RemoteDetector,
} from "../../frontend/src/inference/remote";
import type { FrameResult, TrackView } from "../../shared/src/schemas";
import { frame as frameFixture } from "../contracts/fixtures";

const look = (
  text: string | null,
  confidence: number | null,
  quality = 0.8,
  detectorConfidence: number | null = 0.9,
): PlateObservation => ({ text, confidence, detectorConfidence, quality });

describe("B40 plate multi-frame consensus", () => {
  it("agrees on the reading the frames actually support", () => {
    const result = plateConsensus([
      look("ABC1234", 0.95),
      look("ABCI234", 0.66),
      look("ABC1234", 0.93),
      look("ABC1234", 0.89),
    ]);
    expect(result.plateText).toBe("ABC1234");
    expect(result.supportingFrames).toBe(4);
    expect(result.plateConfidence).toBeGreaterThan(PLATE_LIMITS.minConfidence);
  });
  it("groups confusable glyphs so disagreeing frames still vote together", () => {
    expect(shapeKey("ABCI234")).toBe(shapeKey("ABC1234"));
    expect(shapeKey("5BG")).toBe(shapeKey("S86"));
    expect(shapeKey("ABC")).not.toBe(shapeKey("ABD"));
  });
  it("resolves an ambiguous position by weight, not by reading order", () => {
    const result = plateConsensus([
      look("B12345", 0.6, 0.4),
      look("812345", 0.95, 0.95),
      look("812345", 0.92, 0.9),
    ]);
    expect(result.plateText).toBe("812345");
  });
  it("never invents a character the frames did not contain", () => {
    // Different lengths cannot share a shape, so they never merge into a
    // padded compromise; the better supported length simply wins.
    const result = plateConsensus([
      look("ABC12", 0.9),
      look("ABC12", 0.88),
      look("ABC123", 0.91),
    ]);
    expect(result.plateText).toBe("ABC12");
    expect(result.plateText?.length).toBe(5);
  });
  it("returns null rather than trusting one lucky frame", () => {
    const result = plateConsensus([look("ABC1234", 0.99)]);
    expect(result.plateText).toBeNull();
    expect(result.supportingFrames).toBe(1);
  });
  it("returns null when agreement is too weak to assert", () => {
    const result = plateConsensus([
      look("ABC1234", 0.3, 0.3),
      look("XYZ9876", 0.29, 0.3),
      look("QQQ1111", 0.28, 0.3),
    ]);
    expect(result.plateText).toBeNull();
    expect(result.plateConfidence).toBeNull();
  });
  it("counts frames that read nothing as evidence against a lone reading", () => {
    const supported = plateConsensus([look("ABC1234", 0.95), look("ABC1234", 0.94)]);
    const contradicted = plateConsensus([
      look("ABC1234", 0.95),
      look("ABC1234", 0.94),
      look(null, null),
      look(null, null),
      look(null, null),
      look(null, null),
    ]);
    expect(supported.plateConfidence).toBeGreaterThan(
      contradicted.plateConfidence ?? 0,
    );
  });
  it("reports nothing at all when no frame produced a reading", () => {
    const result = plateConsensus([look(null, null), look(null, null)]);
    expect(result).toMatchObject({
      plateText: null,
      plateConfidence: null,
      supportingFrames: 0,
      observations: 2,
    });
  });
});

const candidate = (over: Partial<Parameters<typeof cropQuality>[0]> = {}) => ({
  bbox: [0.35, 0.35, 0.6, 0.62] as [number, number, number, number],
  sourceWidth: 1920,
  sourceHeight: 1080,
  detectionScore: 0.9,
  sharpness: 20,
  ...over,
});

describe("B41 plate crop selection and quality ranking", () => {
  it("refuses a crop with too few real pixels to hold a plate", () => {
    expect(
      cropQuality(candidate({ bbox: [0.5, 0.5, 0.51, 0.51] })),
    ).toBe(0);
  });
  it("prefers the larger crop of the same vehicle", () => {
    expect(cropQuality(candidate())).toBeGreaterThan(
      cropQuality(candidate({ bbox: [0.4, 0.4, 0.48, 0.49] })),
    );
  });
  it("prefers the sharper crop over the blurred one", () => {
    expect(cropQuality(candidate({ sharpness: 20 }))).toBeGreaterThan(
      cropQuality(candidate({ sharpness: 1 })),
    );
  });
  it("penalises a vehicle cut off by the frame edge", () => {
    expect(cropQuality(candidate())).toBeGreaterThan(
      cropQuality(candidate({ bbox: [0, 0.35, 0.25, 0.62] })),
    );
  });
  it("penalises an edge-on side view whose plate cannot be read", () => {
    expect(cropQuality(candidate())).toBeGreaterThan(
      cropQuality(candidate({ bbox: [0.1, 0.4, 0.9, 0.55] })),
    );
  });
  it("keeps every score inside a comparable unit range", () => {
    for (const entry of [candidate(), candidate({ sharpness: 1e6 })])
      expect(cropQuality(entry)).toBeLessThanOrEqual(1);
  });
});

describe("B42 plate report projection", () => {
  const state = (over = {}) => ({
    status: "read" as const,
    plateText: "ABC1234",
    plateConfidence: 0.9,
    supportingFrames: 3,
    detectorConfidence: 0.8,
    submitted: 3,
    plateBox: null,
    ...over,
  });
  it("says nothing for a track that never entered the pipeline", () => {
    expect(plateFields(state({ status: "idle" }))).toBeNull();
  });
  it("projects a settled reading with its supporting frames", () => {
    expect(plateFields(state())).toEqual({
      plateStatus: "read",
      plateText: "ABC1234",
      plateConfidence: 0.9,
      plateSupportingFrames: 3,
      plateDetectorConfidence: 0.8,
    });
  });
  it("never carries text on a status that did not settle", () => {
    for (const status of ["pending", "unreadable", "unavailable"] as const) {
      const fields = plateFields(state({ status }));
      expect(fields?.plateStatus).toBe(status);
      expect(fields?.plateText).toBeNull();
      expect(fields?.plateConfidence).toBeNull();
    }
  });
  it("reports an unavailable pipeline as carrying no evidence", () => {
    expect(plateFields(state({ status: "unavailable" }))).toMatchObject({
      plateSupportingFrames: 0,
      plateDetectorConfidence: null,
    });
  });
});

/** Minimal canvas stand-in: the controller only needs its pixel dimensions. */
const fakeCanvas = (width = 1920, height = 1080) =>
  ({
    width,
    height,
    getContext: () => null,
  }) as unknown as HTMLCanvasElement;
interface FakeRemote {
  plateAvailable: boolean;
  plateInFlight: number;
  calls: { trackId: number; captureEpoch: string }[];
  readPlate: RemoteDetector["readPlate"];
}
const track = (over: Partial<TrackView> = {}): TrackView => ({
  trackId: 1,
  className: "car",
  score: 0.9,
  bbox: [0.3, 0.3, 0.62, 0.65],
  observed: true,
  speedMps: null,
  speedStatus: "unavailable",
  speedReason: "not_calibrated",
  ruleState: "candidate",
  ...over,
});
const analysed = (seq: number, tracks: TrackView[], epoch?: string): FrameResult => {
  const base = frameFixture(seq);
  const captureEpoch = epoch ?? base.captureEpoch;
  return {
    ...base,
    captureEpoch,
    frameSeq: seq,
    frameId: `${captureEpoch}:${seq}`,
    tracks,
  };
};

function fakeRemote(
  reply: (trackId: number, call: number) => unknown = () => ({}),
): FakeRemote {
  let call = 0;
  const remote: FakeRemote = {
    plateAvailable: true,
    plateInFlight: 0,
    calls: [],
    readPlate: (async (
      _canvas: HTMLCanvasElement,
      request: PlateRequest,
    ) => {
      remote.calls.push({
        trackId: request.trackId,
        captureEpoch: request.captureEpoch,
      });
      const answer = reply(request.trackId, call++);
      if (answer instanceof Error) throw answer;
      return {
        ...request,
        roomId: "00000000-0000-4000-8000-000000000000",
        requestId: crypto.randomUUID(),
        detectorId: "plate-detector-v1",
        detectorSha256: "b".repeat(64),
        ocrEngine: "fast-plate-ocr",
        inputSize: 640,
        plateText: "ABC1234",
        plateConfidence: 0.93,
        detectorConfidence: 0.85,
        plateBox: [0.1, 0.2, 0.6, 0.4],
        metrics: { decodeMs: 1, detectMs: 3, ocrMs: 4, totalMs: 8 },
        v: 1,
        type: "plate.result",
        ...(answer as object),
      };
    }) as unknown as RemoteDetector["readPlate"],
  };
  return remote;
}
const asRemote = (remote: FakeRemote) => remote as unknown as RemoteDetector;
/** Let the controller's fire-and-forget submission settle. */
const settle = async () => {
  for (let index = 0; index < 6; index++) await Promise.resolve();
};

describe("B43 bounded event-driven plate capture", () => {
  let plates: PlateCapture;
  beforeEach(() => {
    plates = new PlateCapture();
    (globalThis as { document?: unknown }).document = {
      createElement: () => fakeCanvas(8, 8),
    };
  });
  it("reads nothing while no vehicle is qualified", async () => {
    const remote = fakeRemote();
    plates.observe(
      analysed(1, [track({ ruleState: "normal" })]),
      fakeCanvas(),
      asRemote(remote),
    );
    await settle();
    expect(remote.calls).toHaveLength(0);
    expect(plates.state(1).status).toBe("idle");
  });
  it("reads a speed candidate without being asked", async () => {
    const remote = fakeRemote();
    plates.observe(analysed(1, [track()]), fakeCanvas(), asRemote(remote));
    await settle();
    expect(remote.calls).toEqual([
      { trackId: 1, captureEpoch: frameFixture(1).captureEpoch },
    ]);
  });
  it("reads a vehicle the operator explicitly selected", async () => {
    const remote = fakeRemote();
    plates.mode = "off";
    plates.request(1);
    plates.observe(
      analysed(1, [track({ ruleState: "normal" })]),
      fakeCanvas(),
      asRemote(remote),
    );
    await settle();
    expect(remote.calls).toHaveLength(1);
  });
  it("never reads a pedestrian or a bicycle", async () => {
    const remote = fakeRemote();
    plates.mode = "all";
    plates.observe(
      analysed(1, [
        track({ trackId: 2, className: "person" }),
        track({ trackId: 3, className: "bicycle" }),
      ]),
      fakeCanvas(),
      asRemote(remote),
    );
    await settle();
    expect(remote.calls).toHaveLength(0);
  });
  it("spends a bounded number of frames on one track", async () => {
    const remote = fakeRemote();
    for (let seq = 1; seq <= PLATE_LIMITS.framesPerTrack + 4; seq++) {
      plates.observe(analysed(seq, [track()]), fakeCanvas(), asRemote(remote));
      await settle();
      // The controller enforces its own submission floor on wall-clock time;
      // step past it so the bound under test is the frame budget, not the rate.
      (plates as unknown as { lastSubmittedAt: number }).lastSubmittedAt =
        -Infinity;
    }
    expect(remote.calls.length).toBe(PLATE_LIMITS.framesPerTrack);
  });
  it("keeps at most one plate request outstanding", async () => {
    let release: (() => void) | null = null;
    const remote = fakeRemote();
    remote.readPlate = (async (
      _canvas: HTMLCanvasElement,
      request: PlateRequest,
    ) => {
      remote.calls.push({
        trackId: request.trackId,
        captureEpoch: request.captureEpoch,
      });
      await new Promise<void>((resolve) => (release = resolve));
      throw new PlateUnavailableError("timeout");
    }) as unknown as RemoteDetector["readPlate"];
    plates.observe(analysed(1, [track()]), fakeCanvas(), asRemote(remote));
    await settle();
    for (let seq = 2; seq <= 6; seq++) {
      (plates as unknown as { lastSubmittedAt: number }).lastSubmittedAt =
        -Infinity;
      plates.observe(
        analysed(seq, [track({ trackId: seq })]),
        fakeCanvas(),
        asRemote(remote),
      );
      await settle();
    }
    expect(remote.calls).toHaveLength(1);
    release!();
    await settle();
  });
  it("tracks a bounded number of vehicles at once", async () => {
    const remote = fakeRemote();
    plates.mode = "all";
    plates.observe(
      analysed(
        1,
        Array.from({ length: PLATE_LIMITS.tracks + 6 }, (_unused, index) =>
          track({ trackId: index + 1 }),
        ),
      ),
      fakeCanvas(),
      asRemote(remote),
    );
    await settle();
    expect(plates.diagnostics.tracks).toBe(PLATE_LIMITS.tracks);
  });
  it("discards every reading when the capture epoch changes", async () => {
    const remote = fakeRemote();
    plates.observe(analysed(1, [track()]), fakeCanvas(), asRemote(remote));
    await settle();
    plates.observe(
      analysed(1, [track()], "44444444-4444-4444-8444-444444444444"),
      fakeCanvas(),
      asRemote(remote),
    );
    expect(plates.state(1).status).toBe("idle");
    expect(plates.state(1).plateText).toBeNull();
  });
  it("rejects a reading that belongs to a superseded epoch", async () => {
    const remote = fakeRemote(() => ({
      captureEpoch: "55555555-5555-4555-8555-555555555555",
    }));
    plates.observe(analysed(1, [track()]), fakeCanvas(), asRemote(remote));
    await settle();
    expect(plates.state(1).plateText).toBeNull();
    expect(plates.state(1).supportingFrames).toBe(0);
  });
  it("rejects a reading attributed to a different track", async () => {
    const remote = fakeRemote(() => ({ trackId: 99 }));
    plates.observe(analysed(1, [track()]), fakeCanvas(), asRemote(remote));
    await settle();
    expect(plates.state(1).supportingFrames).toBe(0);
  });
  it("reports a worker without a plate pipeline as unavailable", async () => {
    const remote = fakeRemote();
    remote.plateAvailable = false;
    plates.observe(analysed(1, [track()]), fakeCanvas(), asRemote(remote));
    await settle();
    expect(remote.calls).toHaveLength(0);
    expect(plates.state(1).status).toBe("unavailable");
    expect(plateFields(plates.state(1))?.plateStatus).toBe("unavailable");
  });
  it("does nothing at all without a GPU worker", async () => {
    plates.observe(analysed(1, [track()]), fakeCanvas(), null);
    await settle();
    expect(plates.state(1).status).toBe("idle");
  });
  it("gives a track its frame budget back when a request is refused", async () => {
    const remote = fakeRemote(() => new PlateUnavailableError("busy"));
    plates.observe(analysed(1, [track()]), fakeCanvas(), asRemote(remote));
    await settle();
    expect(plates.state(1).submitted).toBe(0);
    expect(plates.diagnostics.refused).toBe(1);
  });
  it("stays pending until the frame budget is spent, then says unreadable", async () => {
    const remote = fakeRemote(() => ({
      plateText: null,
      plateConfidence: null,
    }));
    for (let seq = 1; seq <= PLATE_LIMITS.framesPerTrack; seq++) {
      plates.observe(analysed(seq, [track()]), fakeCanvas(), asRemote(remote));
      await settle();
      if (seq < PLATE_LIMITS.framesPerTrack)
        expect(plates.state(1).status).toBe("pending");
      (plates as unknown as { lastSubmittedAt: number }).lastSubmittedAt =
        -Infinity;
    }
    expect(plates.state(1).status).toBe("unreadable");
    expect(plates.state(1).plateText).toBeNull();
  });
  it("settles on a reading once enough frames agree", async () => {
    const remote = fakeRemote();
    for (let seq = 1; seq <= PLATE_LIMITS.minSupportingFrames; seq++) {
      plates.observe(analysed(seq, [track()]), fakeCanvas(), asRemote(remote));
      await settle();
      (plates as unknown as { lastSubmittedAt: number }).lastSubmittedAt =
        -Infinity;
    }
    const state = plates.state(1);
    expect(state.status).toBe("read");
    expect(state.plateText).toBe("ABC1234");
    expect(state.supportingFrames).toBe(PLATE_LIMITS.minSupportingFrames);
  });
  it("forgets every crop, reading and consensus on reset", async () => {
    const remote = fakeRemote();
    for (let seq = 1; seq <= PLATE_LIMITS.minSupportingFrames; seq++) {
      plates.observe(analysed(seq, [track()]), fakeCanvas(), asRemote(remote));
      await settle();
      (plates as unknown as { lastSubmittedAt: number }).lastSubmittedAt =
        -Infinity;
    }
    expect(plates.state(1).plateText).toBe("ABC1234");
    plates.reset();
    expect(plates.state(1)).toMatchObject({
      status: "idle",
      plateText: null,
      supportingFrames: 0,
    });
    expect(plates.diagnostics).toMatchObject({
      tracks: 0,
      submitted: 0,
      completed: 0,
    });
    expect(JSON.stringify(plates)).not.toContain("ABC1234");
  });
});

/**
 * Plate localisation feedback for the selected vehicle. The worker reports the
 * plate box inside the crop it was sent, so the only meaningful check is that
 * mapping it back through that crop lands inside the vehicle it came from.
 */
describe("B44 plate localisation for the selected vehicle", () => {
  let plates: PlateCapture;
  beforeEach(() => {
    plates = new PlateCapture();
    (globalThis as { document?: unknown }).document = {
      createElement: () => fakeCanvas(8, 8),
    };
  });
  it("carries no plate box before anything has been read", () => {
    expect(plates.state(1).plateBox).toBeNull();
  });
  it("maps the worker's crop-relative box into frame coordinates", async () => {
    const remote = fakeRemote();
    const vehicle = track({ bbox: [0.3, 0.3, 0.62, 0.65] });
    plates.observe(analysed(1, [vehicle]), fakeCanvas(), asRemote(remote));
    await settle();
    const box = plates.state(1).plateBox;
    expect(box).not.toBeNull();
    // The padded crop extends a little beyond the vehicle box; the plate must
    // still land inside that padded region rather than somewhere else entirely.
    const padX = (0.62 - 0.3) * 0.06;
    const padY = (0.65 - 0.3) * 0.06;
    expect(box![0]).toBeGreaterThanOrEqual(0.3 - padX - 1e-9);
    expect(box![1]).toBeGreaterThanOrEqual(0.3 - padY - 1e-9);
    expect(box![2]).toBeLessThanOrEqual(0.62 + padX + 1e-9);
    expect(box![3]).toBeLessThanOrEqual(0.65 + padY + 1e-9);
    expect(box![2]).toBeGreaterThan(box![0]);
    expect(box![3]).toBeGreaterThan(box![1]);
  });
  it("keeps no plate box when the worker localised nothing", async () => {
    const remote = fakeRemote(() => ({
      plateText: null,
      plateConfidence: null,
      plateBox: null,
    }));
    plates.observe(analysed(1, [track()]), fakeCanvas(), asRemote(remote));
    await settle();
    expect(plates.state(1).plateBox).toBeNull();
  });
  it("drops the localisation with everything else on reset", async () => {
    const remote = fakeRemote();
    plates.observe(analysed(1, [track()]), fakeCanvas(), asRemote(remote));
    await settle();
    expect(plates.state(1).plateBox).not.toBeNull();
    plates.reset();
    expect(plates.state(1).plateBox).toBeNull();
  });
});

/**
 * Two defects found by driving the deployed build against the live GPU worker,
 * where the selected vehicle sat on "Analyzing…" indefinitely.
 */
describe("B45 plate analysis always reaches a verdict", () => {
  let clock: number;
  let plates: PlateCapture;
  beforeEach(() => {
    clock = 0;
    plates = new PlateCapture(() => clock);
    (globalThis as { document?: unknown }).document = {
      createElement: () => fakeCanvas(8, 8),
    };
  });

  /**
   * The root cause: candidates were ranked by quality and truncated, but only a
   * candidate from the current frame can be cropped from the canvas in hand. On
   * a steady scene every look scores almost the same, so the buffer filled with
   * frames whose pixels were gone and nothing was ever submitted again.
   */
  it("keeps submitting while a steady vehicle stays in view", async () => {
    const remote = fakeRemote(() => ({
      plateText: null,
      plateConfidence: null,
    }));
    for (let seq = 1; seq <= 10; seq++) {
      clock += 400;
      plates.observe(analysed(seq, [track()]), fakeCanvas(), asRemote(remote));
      await settle();
      (plates as unknown as { lastSubmittedAt: number }).lastSubmittedAt =
        -Infinity;
    }
    expect(remote.calls.length).toBeGreaterThanOrEqual(
      PLATE_LIMITS.framesPerTrack,
    );
    expect(plates.state(1).status).toBe("unreadable");
  });

  it("settles to unreadable once the deadline passes", async () => {
    const remote = fakeRemote(() => ({
      plateText: null,
      plateConfidence: null,
    }));
    plates.observe(analysed(1, [track()]), fakeCanvas(), asRemote(remote));
    await settle();
    // Still inside the deadline with budget left: a verdict would be premature.
    expect(plates.state(1).status).toBe("pending");
    clock += PLATE_LIMITS.analysisDeadlineMs;
    expect(plates.state(1).status).toBe("unreadable");
  });

  it("reports a settled reading rather than the deadline verdict", async () => {
    const remote = fakeRemote();
    for (let seq = 1; seq <= PLATE_LIMITS.minSupportingFrames; seq++) {
      clock += 400;
      plates.observe(analysed(seq, [track()]), fakeCanvas(), asRemote(remote));
      await settle();
      (plates as unknown as { lastSubmittedAt: number }).lastSubmittedAt =
        -Infinity;
    }
    clock += PLATE_LIMITS.analysisDeadlineMs;
    expect(plates.state(1).status).toBe("read");
    expect(plates.state(1).plateText).toBe("ABC1234");
  });

  it("never leaves a requested vehicle pending forever", async () => {
    const remote = fakeRemote(
      () => new PlateUnavailableError("plate_failed"),
    );
    plates.mode = "off";
    plates.request(1);
    plates.observe(
      analysed(1, [track({ ruleState: "normal" })]),
      fakeCanvas(),
      asRemote(remote),
    );
    await settle();
    clock += PLATE_LIMITS.analysisDeadlineMs;
    expect(plates.state(1).status).toBe("unreadable");
  });
});
