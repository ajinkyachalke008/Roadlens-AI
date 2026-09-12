import { describe, expect, it } from "vitest";
import {
  SHOWCASE_ARMING_MS,
  SHOWCASE_TARGET_WAIT_MS,
  SHOWCASE_WAIT_MS,
  ShowcaseController,
  eligibleShowcaseTrack,
  selectShowcaseTrack,
  showcaseScore,
  showcaseStatusLabel,
} from "../../frontend/src/showcase/controller";
import type { FrameResult, TrackView } from "../../shared/src/schemas";
import { frame as frameFixture } from "../contracts/fixtures";

const track = (over: Partial<TrackView> = {}): TrackView => ({
  trackId: 1,
  className: "car",
  score: 0.9,
  bbox: [0.3, 0.25, 0.7, 0.7],
  observed: true,
  speedMps: null,
  speedStatus: "unavailable",
  speedReason: "handheld",
  ruleState: "unmeasured",
  trackState: "confirmed",
  observedMs: 1_000,
  ...over,
});

const analysed = (
  sourceTimeMs: number,
  tracks: TrackView[] = [track()],
  captureEpoch?: string,
): FrameResult => {
  const result = frameFixture(Math.max(1, Math.floor(sourceTimeMs / 100) + 1));
  const epoch = captureEpoch ?? result.captureEpoch;
  return {
    ...result,
    captureEpoch: epoch,
    frameId: `${epoch}:${result.frameSeq}`,
    sourceTimeMs,
    tracks,
  };
};

describe("Showcase eligibility and deterministic target scoring", () => {
  it("accepts only a real, observed, confirmed, sufficiently visible vehicle", () => {
    const result = analysed(6_000);
    expect(eligibleShowcaseTrack(track(), result)).toBe(true);
    expect(eligibleShowcaseTrack(track({ className: "person" }), result)).toBe(
      false,
    );
    expect(
      eligibleShowcaseTrack(track({ trackState: "tentative" }), result),
    ).toBe(false);
    expect(eligibleShowcaseTrack(track({ observed: false }), result)).toBe(
      false,
    );
    expect(eligibleShowcaseTrack(track({ score: 0.59 }), result)).toBe(false);
    expect(eligibleShowcaseTrack(track({ observedMs: 99 }), result)).toBe(
      false,
    );
    expect(
      eligibleShowcaseTrack(track({ bbox: [0.1, 0.1, 0.12, 0.12] }), result),
    ).toBe(false);
  });

  it("chooses the large central vehicle over an edge car, truck, and person", () => {
    const smallEdgeCar = track({
      trackId: 4,
      score: 0.99,
      bbox: [0.01, 0.05, 0.15, 0.28],
      observedMs: 3_000,
    });
    const centerCar = track({
      trackId: 8,
      score: 0.84,
      bbox: [0.28, 0.24, 0.72, 0.68],
      observedMs: 1_500,
    });
    const truck = track({
      trackId: 2,
      className: "truck",
      score: 0.97,
      bbox: [0.35, 0.3, 0.7, 0.64],
      observedMs: 2_500,
    });
    const person = track({
      trackId: 1,
      className: "person",
      score: 1,
      bbox: [0.15, 0.15, 0.85, 0.9],
      observedMs: 8_000,
    });
    const result = analysed(6_000, [smallEdgeCar, centerCar, truck, person]);
    expect(showcaseScore(centerCar, result)).toBeGreaterThan(
      showcaseScore(truck, result),
    );
    expect(selectShowcaseTrack(result)?.trackId).toBe(8);
  });

  it("breaks an exact visual-score tie by the lower stable track ID", () => {
    const result = analysed(6_000, [
      track({ trackId: 19 }),
      track({ trackId: 3 }),
    ]);
    expect(selectShowcaseTrack(result)?.trackId).toBe(3);
  });

  it("excludes a tracker-ambiguous identity without adding it to the wire schema", () => {
    const result = analysed(6_000, [
      track({ trackId: 1 }),
      track({ trackId: 2, score: 0.8 }),
    ]);
    expect(selectShowcaseTrack(result, new Set([1]))?.trackId).toBe(2);
  });
});

describe("Showcase source-time state machine", () => {
  it("defaults off, toggles cleanly, and resets without persistence", () => {
    const controller = new ShowcaseController();
    expect(controller.snapshot()).toMatchObject({
      enabled: false,
      phase: "off",
      targetTrackId: null,
      reportId: null,
    });
    expect(controller.setEnabled(true).phase).toBe("arming");
    expect(controller.setEnabled(false)).toMatchObject({
      enabled: false,
      phase: "off",
      captureEpoch: null,
    });
  });

  it("cannot target or report before the minimum arming delay", () => {
    const controller = new ShowcaseController();
    controller.setEnabled(true);
    expect(controller.onFrame(analysed(100))).toBeNull();
    expect(
      controller.onFrame(analysed(100 + SHOWCASE_ARMING_MS - 1)),
    ).toBeNull();
    expect(controller.snapshot()).toMatchObject({
      phase: "arming",
      targetTrackId: null,
      reportId: null,
    });
    expect(
      controller.onFrame(analysed(100 + SHOWCASE_ARMING_MS))?.trackId,
    ).toBe(1);
    expect(controller.snapshot()).toMatchObject({
      phase: "target_ready",
      targetTrackId: 1,
      triggerReason: "capture_quality",
    });
  });

  it("waits truthfully with an empty or person-only scene and then times out", () => {
    const controller = new ShowcaseController();
    controller.setEnabled(true);
    controller.onFrame(analysed(0, []));
    expect(
      controller.onFrame(
        analysed(SHOWCASE_ARMING_MS, [
          track({ className: "person", trackId: 7 }),
        ]),
      ),
    ).toBeNull();
    expect(showcaseStatusLabel(controller.snapshot())).toBe(
      "Looking for clear vehicle…",
    );
    expect(controller.snapshot().targetTrackId).toBeNull();
    expect(
      controller.onFrame(
        analysed(SHOWCASE_ARMING_MS + SHOWCASE_WAIT_MS + 1, []),
      ),
    ).toBeNull();
    expect(controller.snapshot()).toMatchObject({
      phase: "timed_out",
      targetTrackId: null,
      reportId: null,
    });
  });

  it("locks one identity, creates one event, and never jumps to another track", () => {
    const controller = new ShowcaseController();
    controller.setEnabled(true);
    controller.onFrame(analysed(0));
    expect(controller.onFrame(analysed(5_000))?.trackId).toBe(1);
    expect(controller.markReportCreated("report-1", "pending")).toMatchObject({
      phase: "plate_collecting",
      targetTrackId: 1,
      reportId: "report-1",
    });
    expect(
      controller.onFrame(analysed(6_000, [track({ trackId: 9 })])),
    ).toBeNull();
    expect(controller.updatePlate("unreadable")).toMatchObject({
      phase: "plate_unreadable",
      targetTrackId: 1,
      reportId: "report-1",
    });
    expect(
      controller.onFrame(analysed(20_000, [track({ trackId: 22 })])),
    ).toBeNull();
  });

  it("waits through small and medium looks, locks once, then fires on a sharper larger frame", () => {
    const controller = new ShowcaseController();
    controller.setEnabled(true);
    controller.onFrame(analysed(0, []));
    const qualities = (sharpness: number, quality: number) =>
      new Map([[1, { sharpness, quality }]]);
    expect(
      controller.onFrame(
        analysed(SHOWCASE_ARMING_MS, [
          track({ bbox: [0.44, 0.4, 0.56, 0.54] }),
        ]),
        new Set(),
        qualities(3, 0.35),
      ),
    ).toBeNull();
    expect(
      controller.onFrame(
        analysed(SHOWCASE_ARMING_MS + 400, [
          track({ bbox: [0.36, 0.32, 0.64, 0.64] }),
        ]),
        new Set(),
        qualities(5, 0.48),
      ),
    ).toBeNull();
    expect(
      controller.onFrame(
        analysed(SHOWCASE_ARMING_MS + 800, [
          track({ bbox: [0.34, 0.3, 0.66, 0.66] }),
        ]),
        new Set(),
        qualities(5, 0.5),
      ),
    ).toBeNull();
    expect(controller.snapshot()).toMatchObject({
      phase: "acquiring",
      targetTrackId: 1,
    });
    const ready = controller.onFrame(
      analysed(SHOWCASE_ARMING_MS + 1_200, [
        track({ bbox: [0.2, 0.16, 0.8, 0.82] }),
      ]),
      new Set(),
      qualities(20, 0.9),
    );
    expect(ready?.trackId).toBe(1);
    expect(controller.snapshot()).toMatchObject({
      phase: "target_ready",
      triggerReason: "capture_quality",
      growth: "growing",
    });
  });

  it("does not switch to a more attractive vehicle after target lock", () => {
    const controller = new ShowcaseController();
    controller.setEnabled(true);
    controller.onFrame(analysed(0, []));
    const moderate = new Map([[1, { sharpness: 5, quality: 0.5 }]]);
    controller.onFrame(
      analysed(SHOWCASE_ARMING_MS, [track({ bbox: [0.35, 0.3, 0.65, 0.65] })]),
      new Set(),
      moderate,
    );
    controller.onFrame(
      analysed(SHOWCASE_ARMING_MS + 900, [
        track({ bbox: [0.34, 0.29, 0.66, 0.66] }),
      ]),
      new Set(),
      moderate,
    );
    expect(controller.snapshot().targetTrackId).toBe(1);
    controller.onFrame(
      analysed(SHOWCASE_ARMING_MS + 1_200, [
        track({ bbox: [0.33, 0.28, 0.67, 0.67] }),
        track({ trackId: 9, bbox: [0.15, 0.12, 0.85, 0.88] }),
      ]),
      new Set(),
      new Map([
        [1, { sharpness: 5, quality: 0.5 }],
        [9, { sharpness: 25, quality: 0.95 }],
      ]),
    );
    expect(controller.snapshot().targetTrackId).toBe(1);
  });

  it("can fire on a strong localized plate before OCR text exists", () => {
    const controller = new ShowcaseController();
    controller.setEnabled(true);
    controller.onFrame(analysed(0, []));
    const quality = new Map([[1, { sharpness: 4, quality: 0.45 }]]);
    const moderate = [track({ bbox: [0.38, 0.34, 0.62, 0.62] })];
    controller.onFrame(
      analysed(SHOWCASE_ARMING_MS, moderate),
      new Set(),
      quality,
    );
    controller.onFrame(
      analysed(SHOWCASE_ARMING_MS + 900, moderate),
      new Set(),
      quality,
    );
    expect(
      controller.onFrame(
        analysed(SHOWCASE_ARMING_MS + 1_200, moderate),
        new Set(),
        quality,
        new Set([1]),
      )?.trackId,
    ).toBe(1);
    expect(controller.snapshot().triggerReason).toBe("plate_localized");
  });

  it("uses a bounded target wait instead of hanging for perfect quality", () => {
    const controller = new ShowcaseController();
    controller.setEnabled(true);
    controller.onFrame(analysed(0, []));
    const quality = new Map([[1, { sharpness: 4, quality: 0.45 }]]);
    const moderate = [track({ bbox: [0.38, 0.34, 0.62, 0.62] })];
    controller.onFrame(
      analysed(SHOWCASE_ARMING_MS, moderate),
      new Set(),
      quality,
    );
    controller.onFrame(
      analysed(SHOWCASE_ARMING_MS + 900, moderate),
      new Set(),
      quality,
    );
    const lockedAt = controller.snapshot().targetLockedAtMs!;
    expect(
      controller.onFrame(
        analysed(lockedAt + SHOWCASE_TARGET_WAIT_MS, moderate),
        new Set(),
        quality,
      )?.trackId,
    ).toBe(1);
    expect(controller.snapshot().triggerReason).toBe("target_wait_expired");
  });

  it("never carries a target across a capture epoch", () => {
    const controller = new ShowcaseController();
    controller.setEnabled(true);
    controller.onFrame(analysed(0));
    controller.onFrame(analysed(5_000));
    expect(controller.snapshot().targetTrackId).toBe(1);
    const nextEpoch = "44444444-4444-4444-8444-444444444444";
    expect(
      controller.onFrame(analysed(6_000, [track()], nextEpoch)),
    ).toBeNull();
    expect(controller.snapshot()).toMatchObject({
      enabled: true,
      phase: "arming",
      captureEpoch: nextEpoch,
      targetTrackId: null,
      reportId: null,
    });
    expect(controller.resetContinuity()).toMatchObject({
      enabled: true,
      phase: "arming",
      captureEpoch: null,
    });
  });
});
