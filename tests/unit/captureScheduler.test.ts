import { describe, expect, it } from "vitest";
import {
  CameraCapture,
  STALLED_STATUS,
} from "../../frontend/src/camera/capture";

type Callback = (now: number, metadata: unknown) => void;

function fakeVideo() {
  return {
    muted: false,
    playsInline: false,
    paused: false,
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 720,
    currentTime: 0,
    srcObject: {} as unknown,
    onended: null as unknown,
    onseeking: null as unknown,
    requests: [] as number[],
    cancelled: [] as number[],
    pending: null as Callback | null,
    requestVideoFrameCallback(callback: Callback) {
      const id = this.requests.length + 1;
      this.requests.push(id);
      this.pending = callback;
      return id;
    },
    cancelVideoFrameCallback(id: number) {
      this.cancelled.push(id);
      this.pending = null;
    },
    play: async () => {},
    pause() {},
    load() {},
    removeAttribute() {},
  };
}

interface Internals {
  running: boolean;
  lastCallbackAt: number;
  lastCompletedAt: number;
  schedule(): void;
}

describe("source health watchdog", () => {
  it("replaces stalled frame callbacks once, then reports lost analysis", () => {
    const video = fakeVideo();
    const capture = new CameraCapture(video as unknown as HTMLVideoElement);
    const internals = capture as unknown as Internals;
    const statuses: string[] = [];
    let resets = 0;
    capture.onStatus = (state) => statuses.push(state);
    capture.onReset = () => resets++;
    internals.running = true;
    internals.lastCallbackAt = 1000;
    internals.lastCompletedAt = 1000;
    internals.schedule();
    expect(video.requests).toEqual([1]);
    expect(capture.frameDiagnostics.scheduler).toBe("frame_callback");

    // A source that is still calling back stays on the preferred scheduler.
    capture.checkSourceHealth(1500);
    expect(statuses).toEqual([]);
    expect(capture.frameDiagnostics.scheduler).toBe("frame_callback");

    // Callbacks stopped while the video is visibly playing: one bounded switch.
    capture.checkSourceHealth(3200);
    expect(statuses).toEqual([STALLED_STATUS]);
    expect(capture.frameDiagnostics.scheduler).toBe("timer");
    expect(video.cancelled).toEqual([1]);
    // Exactly one analyser: the frame callback is not re-armed alongside it.
    expect(video.requests).toEqual([1]);
    expect(video.pending).toBeNull();

    // The recovery is not retried in a loop.
    capture.checkSourceHealth(5500);
    expect(statuses).toEqual([STALLED_STATUS]);

    // Still no completed analysis: measurement continuity is dropped and the
    // operator is told, rather than leaving "Live" on screen.
    capture.checkSourceHealth(7000);
    expect(statuses).toEqual([STALLED_STATUS, STALLED_STATUS]);
    expect(resets).toBeGreaterThan(0);
    capture.pause(false);
    expect(capture.frameDiagnostics.acceptedFrames).toBe(0);
  });

  it("leaves a paused or unready source alone", () => {
    const video = fakeVideo();
    const capture = new CameraCapture(video as unknown as HTMLVideoElement);
    const internals = capture as unknown as Internals;
    const statuses: string[] = [];
    capture.onStatus = (state) => statuses.push(state);
    internals.running = true;
    internals.lastCallbackAt = 1000;
    internals.lastCompletedAt = 1000;
    internals.schedule();
    video.paused = true;
    capture.checkSourceHealth(4000);
    expect(capture.frameDiagnostics.scheduler).toBe("frame_callback");
    video.paused = false;
    video.readyState = 0;
    capture.checkSourceHealth(4100);
    expect(capture.frameDiagnostics.scheduler).toBe("frame_callback");
    expect(statuses).toEqual([]);
    capture.pause(false);
  });
});
