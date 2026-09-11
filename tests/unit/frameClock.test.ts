import { describe, expect, it } from "vitest";
import {
  CONTINUITY_GAP_MS,
  FrameClock,
  type FrameSample,
} from "../../frontend/src/camera/frameClock";

/**
 * Metadata captured from a live iPhone Safari getUserMedia stream: the camera
 * is visibly moving, presented frames advance, and mediaTime never leaves 0.
 */
const iosLiveCamera: FrameSample[] = [
  {
    now: 1000,
    metadata: {
      mediaTime: 0,
      presentationTime: 999,
      expectedDisplayTime: 1000,
      presentedFrames: 1,
    },
  },
  {
    now: 1033,
    metadata: {
      mediaTime: 0,
      presentationTime: 1032,
      expectedDisplayTime: 1033,
      presentedFrames: 2,
    },
  },
  {
    now: 1066,
    metadata: {
      mediaTime: 0,
      presentationTime: 1065,
      expectedDisplayTime: 1066,
      presentedFrames: 3,
    },
  },
  {
    now: 1099,
    metadata: {
      mediaTime: 0,
      presentationTime: 1098,
      expectedDisplayTime: 1099,
      presentedFrames: 4,
    },
  },
];

describe("live camera frame clock", () => {
  it("advances every real iPhone frame while mediaTime stays at zero", () => {
    const clock = new FrameClock();
    const ticks = iosLiveCamera.map((sample) => clock.nextLiveFrame(sample));
    expect(ticks.map((t) => t.accept)).toEqual([true, true, true, true]);
    // Frame sequence a capture epoch assigns to the accepted frames.
    expect(ticks.map((_, index) => index)).toEqual([0, 1, 2, 3]);
    expect(ticks.map((t) => t.sourceTimeMs)).toEqual([0, 33, 66, 99]);
    expect(ticks.map((t) => t.frameIdentity)).toEqual([1, 2, 3, 4]);
    expect(ticks.every((t) => t.timingSource === "presentationTime")).toBe(
      true,
    );
    // Only the first frame of the epoch restarts measurement continuity.
    expect(ticks.map((t) => t.discontinuity)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    for (const tick of ticks) {
      expect(Number.isFinite(tick.sourceTimeMs)).toBe(true);
      expect(tick.sourceTimeMs).toBeGreaterThanOrEqual(0);
    }
    const gaps = ticks
      .slice(1)
      .map((t, i) => t.sourceTimeMs - ticks[i]!.sourceTimeMs);
    expect(gaps.every((gap) => gap > 0)).toBe(true);
  });

  it("does not freeze at frame 0 the way media time alone did", () => {
    // The previous rule rejected any frame whose media time repeated, so this
    // exact stream produced one analysed frame and then stopped forever.
    const mediaTimes = iosLiveCamera.map((s) => s.metadata!.mediaTime! * 1000);
    let previous = -1;
    const byMediaTime = mediaTimes.filter((time) => {
      if (time === previous) return false;
      previous = time;
      return true;
    });
    expect(byMediaTime).toEqual([0]);
    const clock = new FrameClock();
    const accepted = iosLiveCamera.filter(
      (sample) => clock.nextLiveFrame(sample).accept,
    );
    expect(accepted).toHaveLength(4);
  });

  it("rejects a repeated presented frame and accepts the next one", () => {
    const clock = new FrameClock();
    const first = clock.nextLiveFrame({
      now: 500,
      metadata: { presentationTime: 500, presentedFrames: 12 },
    });
    expect(first.accept).toBe(true);
    const repeat = clock.nextLiveFrame({
      now: 520,
      metadata: { presentationTime: 520, presentedFrames: 12 },
    });
    expect(repeat.accept).toBe(false);
    expect(repeat.reason).toBe("duplicate_frame");
    const next = clock.nextLiveFrame({
      now: 533,
      metadata: { presentationTime: 533, presentedFrames: 13 },
    });
    expect(next.accept).toBe(true);
    expect(next.frameIdentity).toBe(13);
    expect(next.sourceTimeMs).toBe(33);
    expect(next.discontinuity).toBe(false);
  });

  it("falls back to expectedDisplayTime, then to the callback timestamp", () => {
    const display = new FrameClock();
    const displayTicks = [0, 33, 66].map((offset, index) =>
      display.nextLiveFrame({
        now: 2000 + offset,
        metadata: {
          mediaTime: 0,
          expectedDisplayTime: 3000 + offset,
          presentedFrames: index + 1,
        },
      }),
    );
    expect(displayTicks.every((t) => t.accept)).toBe(true);
    expect(
      displayTicks.every((t) => t.timingSource === "expectedDisplayTime"),
    ).toBe(true);
    expect(displayTicks.map((t) => t.sourceTimeMs)).toEqual([0, 33, 66]);

    const callback = new FrameClock();
    const callbackTicks = [0, 33, 66].map((offset, index) =>
      callback.nextLiveFrame({
        now: 400 + offset,
        metadata: { mediaTime: 0, presentedFrames: index + 1 },
      }),
    );
    expect(callbackTicks.every((t) => t.accept)).toBe(true);
    expect(callbackTicks.every((t) => t.timingSource === "callbackNow")).toBe(
      true,
    );
    expect(callbackTicks.map((t) => t.sourceTimeMs)).toEqual([0, 33, 66]);
  });

  it("never lets malformed presentation timing produce a bad source time", () => {
    const clock = new FrameClock();
    const ticks = [
      clock.nextLiveFrame({
        now: 100,
        metadata: { presentationTime: NaN, presentedFrames: 1 },
      }),
      clock.nextLiveFrame({
        now: 133,
        metadata: { presentationTime: Infinity, presentedFrames: 2 },
      }),
      clock.nextLiveFrame({
        now: 166,
        metadata: { presentationTime: -5, presentedFrames: 3 },
      }),
    ];
    expect(ticks.every((t) => t.accept)).toBe(true);
    expect(ticks.every((t) => t.timingSource === "callbackNow")).toBe(true);
    expect(ticks.map((t) => t.sourceTimeMs)).toEqual([0, 33, 66]);
    expect(ticks.every((t) => Number.isFinite(t.sourceTimeMs))).toBe(true);
    // An unusable callback timestamp is skipped, never invented.
    const unusable = clock.nextLiveFrame({
      now: NaN,
      metadata: { presentedFrames: 4 },
    });
    expect(unusable.accept).toBe(false);
    expect(unusable.reason).toBe("unusable_timing");
  });

  it("restarts continuity instead of going backwards on a bad timestamp", () => {
    const clock = new FrameClock();
    clock.nextLiveFrame({
      now: 1000,
      metadata: { presentationTime: 1000, presentedFrames: 1 },
    });
    const forward = clock.nextLiveFrame({
      now: 1033,
      metadata: { presentationTime: 1033, presentedFrames: 2 },
    });
    expect(forward.sourceTimeMs).toBe(33);
    const backwards = clock.nextLiveFrame({
      now: 1066,
      metadata: { presentationTime: 900, presentedFrames: 3 },
    });
    expect(backwards.accept).toBe(true);
    expect(backwards.discontinuity).toBe(true);
    expect(backwards.sourceTimeMs).toBe(0);
    const after = clock.nextLiveFrame({
      now: 1099,
      metadata: { presentationTime: 933, presentedFrames: 4 },
    });
    expect(after.sourceTimeMs).toBe(33);
    expect(after.discontinuity).toBe(false);
  });

  it("restarts continuity when a stalled clock forces another timing source", () => {
    const clock = new FrameClock();
    // A presentation clock pinned at zero must not freeze analysis either.
    const first = clock.nextLiveFrame({
      now: 1000,
      metadata: { presentationTime: 0, presentedFrames: 1 },
    });
    expect(first.timingSource).toBe("presentationTime");
    const second = clock.nextLiveFrame({
      now: 1033,
      metadata: { presentationTime: 0, presentedFrames: 2 },
    });
    expect(second.accept).toBe(true);
    expect(second.timingSource).toBe("callbackNow");
    expect(second.discontinuity).toBe(true);
    expect(second.sourceTimeMs).toBe(0);
    const third = clock.nextLiveFrame({
      now: 1066,
      metadata: { presentationTime: 0, presentedFrames: 3 },
    });
    expect(third.sourceTimeMs).toBe(33);
    expect(third.timingSource).toBe("callbackNow");
    expect(third.discontinuity).toBe(false);
  });

  it("restarts continuity after a counter restart or a long gap", () => {
    const clock = new FrameClock();
    clock.nextLiveFrame({
      now: 1000,
      metadata: { presentationTime: 1000, presentedFrames: 40 },
    });
    const restarted = clock.nextLiveFrame({
      now: 1033,
      metadata: { presentationTime: 1033, presentedFrames: 2 },
    });
    expect(restarted.accept).toBe(true);
    expect(restarted.discontinuity).toBe(true);
    expect(restarted.sourceTimeMs).toBe(0);
    const gapped = clock.nextLiveFrame({
      now: 1033 + CONTINUITY_GAP_MS + 100,
      metadata: {
        presentationTime: 1033 + CONTINUITY_GAP_MS + 100,
        presentedFrames: 3,
      },
    });
    expect(gapped.discontinuity).toBe(true);
    expect(gapped.sourceTimeMs).toBe(0);
  });

  it("normalises again from zero after a reset", () => {
    const clock = new FrameClock();
    clock.nextLiveFrame({
      now: 1000,
      metadata: { presentationTime: 1000, presentedFrames: 1 },
    });
    clock.nextLiveFrame({
      now: 1033,
      metadata: { presentationTime: 1033, presentedFrames: 2 },
    });
    expect(clock.sourceTimeMs).toBe(33);
    clock.reset();
    expect(clock.sourceTimeMs).toBe(0);
    expect(clock.timingSource).toBeNull();
    expect(clock.presentedFrames).toBeNull();
    const resumed = clock.nextLiveFrame({
      now: 90_000,
      metadata: { presentationTime: 90_000, presentedFrames: 900 },
    });
    expect(resumed.sourceTimeMs).toBe(0);
    expect(resumed.discontinuity).toBe(true);
    expect(
      clock.nextLiveFrame({
        now: 90_033,
        metadata: { presentationTime: 90_033, presentedFrames: 901 },
      }).sourceTimeMs,
    ).toBe(33);
  });

  it("reads only the sample, so relay and worker latency cannot shift it", () => {
    const sample: FrameSample = {
      now: 5000,
      metadata: { presentationTime: 4999, presentedFrames: 7 },
    };
    const early = new FrameClock();
    const late = new FrameClock();
    early.nextLiveFrame(sample);
    late.nextLiveFrame(sample);
    const next: FrameSample = {
      now: 5033,
      metadata: { presentationTime: 5032, presentedFrames: 8 },
    };
    // The same frames analysed at any wall-clock moment give the same delta.
    expect(early.nextLiveFrame(next).sourceTimeMs).toBe(33);
    expect(late.nextLiveFrame(next).sourceTimeMs).toBe(33);
  });
});

describe("replay frame clock", () => {
  const replay = (clock: FrameClock, mediaTime: number, now = 0) =>
    clock.nextReplayFrame({ now, metadata: { mediaTime, presentedFrames: 1 } });

  it("keeps the media timeline as the source time", () => {
    const clock = new FrameClock();
    const ticks = [0, 0.033, 0.066, 0.1].map((t, i) =>
      replay(clock, t, i * 16),
    );
    expect(ticks.every((t) => t.accept)).toBe(true);
    expect(ticks.every((t) => t.timingSource === "mediaTime")).toBe(true);
    expect(ticks[0]!.sourceTimeMs).toBe(0);
    expect(ticks[1]!.sourceTimeMs).toBeCloseTo(33, 6);
    expect(ticks[2]!.sourceTimeMs).toBeCloseTo(66, 6);
    expect(ticks[3]!.sourceTimeMs).toBeCloseTo(100, 6);
    expect(ticks.slice(1).map((t) => t.discontinuity)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("rejects a repeated media time while paused and resumes cleanly", () => {
    const clock = new FrameClock();
    expect(replay(clock, 4.0).accept).toBe(true);
    const paused = replay(clock, 4.0);
    expect(paused.accept).toBe(false);
    expect(paused.reason).toBe("duplicate_media_time");
    expect(replay(clock, 4.0).accept).toBe(false);
    const resumed = replay(clock, 4.033);
    expect(resumed.accept).toBe(true);
    expect(resumed.discontinuity).toBe(false);
    expect(resumed.sourceTimeMs).toBeCloseTo(4033, 6);
  });

  it("restarts continuity on a backward seek and on a large forward seek", () => {
    const clock = new FrameClock();
    expect(replay(clock, 12.3).sourceTimeMs).toBeCloseTo(12300, 6);
    const back = replay(clock, 4.0);
    expect(back.accept).toBe(true);
    expect(back.discontinuity).toBe(true);
    expect(back.sourceTimeMs).toBe(4000);
    const ahead = replay(clock, 30.0);
    expect(ahead.discontinuity).toBe(true);
    expect(ahead.sourceTimeMs).toBe(30_000);
    expect(replay(clock, 30.033).discontinuity).toBe(false);
  });

  it("uses the media position of the element when metadata is absent", () => {
    const clock = new FrameClock();
    const tick = clock.nextReplayFrame({ now: 10, currentTime: 2.5 });
    expect(tick.accept).toBe(true);
    expect(tick.sourceTimeMs).toBe(2500);
    expect(tick.timingSource).toBe("mediaTime");
    const unusable = clock.nextReplayFrame({ now: 20 });
    expect(unusable.accept).toBe(false);
    expect(unusable.reason).toBe("unusable_timing");
  });

  it("does not borrow the presentation clock of the live camera", () => {
    const clock = new FrameClock();
    const tick = clock.nextReplayFrame({
      now: 900_000,
      metadata: {
        mediaTime: 1.5,
        presentationTime: 900_000,
        expectedDisplayTime: 900_016,
        presentedFrames: 45,
      },
    });
    expect(tick.sourceTimeMs).toBe(1500);
    expect(tick.timingSource).toBe("mediaTime");
  });
});
