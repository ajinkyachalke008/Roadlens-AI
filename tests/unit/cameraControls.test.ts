import { describe, expect, it } from "vitest";
import { CameraCapture } from "../../frontend/src/camera/capture";
import type { FrameRateChoice } from "../../frontend/src/camera/frameRate";

function fakeVideo() {
  return {
    muted: false,
    playsInline: false,
    paused: false,
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 720,
    currentTime: 2.5,
    srcObject: {} as unknown,
    onended: null as unknown,
    onseeking: null as unknown,
    requestVideoFrameCallback: () => 1,
    cancelVideoFrameCallback: () => {},
    play: async () => {},
    pause() {},
    load() {},
    removeAttribute() {},
  };
}

function fakeTrack(
  capabilities: unknown,
  settings: { frameRate?: number },
  options: { reject?: boolean; selects?: number } = {},
) {
  const applied: unknown[] = [];
  return {
    applied,
    settings,
    getCapabilities: () => capabilities,
    getSettings: () => settings,
    async applyConstraints(constraints: unknown) {
      applied.push(constraints);
      if (options.reject) throw new Error("OverconstrainedError");
      const requested = (
        constraints as { frameRate?: { ideal?: number } } | undefined
      )?.frameRate?.ideal;
      // A real camera answers with what it actually selected.
      if (typeof requested === "number")
        settings.frameRate = options.selects ?? requested;
    },
  };
}

function capture(track?: unknown) {
  const video = fakeVideo();
  const instance = new CameraCapture(video as unknown as HTMLVideoElement);
  if (track) (instance as unknown as { track: unknown }).track = track;
  return { instance, video };
}

describe("camera frame rate control", () => {
  it("derives options from the track and reports the selected rate", async () => {
    const track = fakeTrack(
      { frameRate: { min: 1, max: 60 } },
      { frameRate: 30 },
    );
    const { instance } = capture(track);
    expect(instance.cameraFrameRate.options).toEqual([24, 30, 60]);
    expect(instance.cameraFrameRate.actual).toBe(30);
    expect(instance.cameraFrameRate.requested).toBe("auto");
    const result = await instance.applyFrameRate(60);
    expect(result.applied).toBe(true);
    expect(result.status.actual).toBe(60);
    expect(result.status.note).toBe("60.0 FPS");
    expect(track.applied).toHaveLength(1);
    expect(track.applied[0]).toMatchObject({ frameRate: { ideal: 60 } });
    instance.end();
  });

  it("reports the camera's own choice when it differs from the request", async () => {
    const track = fakeTrack(
      { frameRate: { min: 1, max: 120 } },
      {
        frameRate: 30,
      },
      { selects: 60 },
    );
    const { instance } = capture(track);
    const result = await instance.applyFrameRate(120);
    expect(result.applied).toBe(true);
    expect(result.status.actual).toBe(60);
    expect(result.status.note).toBe("Requested 120; camera selected 60.0 FPS");
    instance.end();
  });

  it("keeps the previous rate when the track rejects the constraint", async () => {
    const track = fakeTrack(
      { frameRate: { min: 1, max: 30 } },
      { frameRate: 30 },
      { reject: true },
    );
    const { instance } = capture(track);
    const result = await instance.applyFrameRate(24);
    expect(result.applied).toBe(false);
    expect(result.status.actual).toBe(30);
    expect(instance.cameraFrameRate.options).toEqual([24, 30]);
    instance.end();
  });

  it("remembers a request made before a camera track exists", async () => {
    const { instance } = capture();
    const result = await instance.applyFrameRate(60);
    expect(result.applied).toBe(false);
    expect(result.status.supported).toBe(false);
    expect(instance.frameRate).toBe(60);
    expect(result.status.options).toEqual([]);
    instance.end();
  });

  it("clears operator rate choices when the session ends", async () => {
    const track = fakeTrack(
      { frameRate: { min: 1, max: 60 } },
      { frameRate: 30 },
    );
    const { instance } = capture(track);
    await instance.applyFrameRate(60);
    instance.analysisRate = 15;
    instance.end();
    expect(instance.frameRate).toBe("auto" satisfies FrameRateChoice);
    expect(instance.analysisRate).toBe("auto");
  });
});

describe("analysis rate control", () => {
  const withRemote = (
    instance: CameraCapture,
    backoffMs: number,
    intervalMs: number,
  ) =>
    ((instance as unknown as { remote: unknown }).remote = {
      diagnostics: { backoffMs, intervalMs },
      close: () => {},
    });

  it("uses the measured controller in auto and the request in manual", () => {
    const { instance } = capture();
    expect(instance.analysisRate).toBe("auto");
    expect(instance.targetIntervalMs()).toBe(190);
    instance.analysisRate = 10;
    expect(instance.targetIntervalMs()).toBe(100);
    instance.analysisRate = 30;
    expect(instance.targetIntervalMs()).toBeCloseTo(1000 / 30, 6);
    instance.end();
  });

  it("never lets an operator target outrun GPU backpressure", () => {
    const { instance } = capture();
    withRemote(instance, 300, 220);
    instance.analysisRate = "auto";
    expect(instance.targetIntervalMs()).toBe(220);
    instance.analysisRate = 30;
    // Congestion floor wins: a manual target can slow analysis, never speed it
    // past what the path is currently accepting.
    expect(instance.targetIntervalMs()).toBe(300);
    instance.analysisRate = 10;
    expect(instance.targetIntervalMs()).toBe(300);
    withRemote(instance, 72, 120);
    instance.analysisRate = 10;
    expect(instance.targetIntervalMs()).toBe(100);
    instance.end();
  });
});

describe("live presentation clock for display", () => {
  it("reads the replay media position and the live clock separately", () => {
    const { instance, video } = capture();
    instance.sourceMode = "replay_video";
    expect(instance.sourceTimeNow()).toBe(2500);
    video.currentTime = 4;
    expect(instance.sourceTimeNow()).toBe(4000);
    instance.sourceMode = "live_camera";
    // No accepted frame yet: the clock reports its last known source time.
    expect(instance.sourceTimeNow(123456)).toBe(0);
    instance.end();
  });
});
