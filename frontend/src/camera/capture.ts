import { DetectorClient } from "../inference/client";
import { TimeAwareTracker, TRACKER_VERSION } from "../tracking/tracker";
import { estimateSpeed, type SpeedEstimate } from "../geometry/speed";
import type { Calibration } from "../geometry/calibration";
import { BackgroundGuard } from "../geometry/background";
import { CandidateRules } from "../rules/candidates";
import {
  emptyCounts,
  FrameSchema,
  type FrameResult,
  type CameraPolicy,
} from "../../../shared/src/schemas";
import { LIMITS } from "../../../shared/src/limits";
import { AdaptivePerformance } from "./performance";
import {
  RemoteDetector,
  GpuDroppedFrameError,
  type GpuDiagnostics,
} from "../inference/remote";
import type { DetectionResult } from "../inference/types";
export interface CompletedFrame {
  result: FrameResult;
  policy: CameraPolicy;
  canvas: HTMLCanvasElement;
  jpeg: Blob;
  jpegWidth: number;
  jpegHeight: number;
  processingMs: number;
  candidates: {
    trackId: number;
    episodeKey: string;
    estimate: SpeedEstimate;
  }[];
}
export const newPolicy = (): CameraPolicy => ({
  version: crypto.randomUUID(),
  roadLabel: "",
  speedLimitMps: null,
  demoMarginMps: 0,
  limitSource: "operator_entered_demo",
});
export async function sampledJpeg(canvas: HTMLCanvasElement) {
  const scale = Math.min(
    1,
    LIMITS.imageEdge / Math.max(canvas.width, canvas.height),
  );
  const small = document.createElement("canvas");
  small.width = Math.round(canvas.width * scale);
  small.height = Math.round(canvas.height * scale);
  small.getContext("2d")!.drawImage(canvas, 0, 0, small.width, small.height);
  let blob: Blob | null = null;
  for (const quality of [0.75, 0.6, 0.45, 0.3]) {
    blob = await new Promise((resolve) =>
      small.toBlob(resolve, "image/jpeg", quality),
    );
    if (blob && blob.size <= LIMITS.jpegTarget) break;
  }
  if (!blob || blob.size > LIMITS.jpegBytes)
    throw new Error("Preview image exceeds memory limit");
  return { blob, width: small.width, height: small.height };
}
export class CameraCapture {
  sourceId = crypto.randomUUID();
  captureEpoch = crypto.randomUUID();
  latest: CompletedFrame | null = null;
  calibration: Calibration | null = null;
  policy = newPolicy();
  mounted = false;
  background: "verified" | "background_unverified" | "camera_moved" =
    "background_unverified";
  sourceMode: "live_camera" | "replay_video" = "live_camera";
  onFrame = (_frame: CompletedFrame) => {};
  onStatus = (_state: string) => {};
  onError = (_message: string) => {};
  onReset = () => {};
  onProfile = (_profile: 416 | 320, _automatic: boolean) => {};
  onInferenceMode = (_mode: string) => {};
  remote: RemoteDetector | null = null;
  private switching = false;
  private activeJob: symbol | null = null;
  private browserProfile: 416 | 320 = 416;
  private sourceFrames = 0;
  private skippedFrames = 0;
  private trackingMs = 0;
  private sourceTimes: number[] = [];
  get operationVersion() {
    return this.generation;
  }
  get gpuDiagnostics():
    | (GpuDiagnostics & {
        sourceFrames: number;
        skippedFrames: number;
        trackingMs: number;
        sourceHz: number;
      })
    | null {
    return this.remote
      ? {
          ...this.remote.diagnostics,
          sourceFrames: this.sourceFrames,
          skippedFrames: this.skippedFrames,
          trackingMs: this.trackingMs,
          sourceHz:
            this.sourceTimes.length > 1
              ? ((this.sourceTimes.length - 1) * 1000) /
                Math.max(1, this.sourceTimes.at(-1)! - this.sourceTimes[0])
              : 0,
        }
      : null;
  }
  private detector: DetectorClient | null = null;
  private tracker = new TimeAwareTracker();
  private guard = new BackgroundGuard();
  private rules = new CandidateRules();
  private stream: MediaStream | null = null;
  private running = false;
  private busy = false;
  private generation = 0;
  private frameSeq = 0;
  private lastSource = -1;
  private lastStartedAt = -Infinity;
  private lastCompletedAt = 0;
  private sourceStalled = false;
  private performancePolicy = new AdaptivePerformance(416);
  private geometry = "";
  private completionTimes: number[] = [];
  private callbackId = 0;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private replayUrl: string | null = null;
  private sourceFile: File | null = null;
  constructor(readonly video: HTMLVideoElement) {
    video.muted = true;
    video.playsInline = true;
    video.onended = () => this.pause();
    video.onseeking = () => this.resetEpoch();
  }
  resetEpoch() {
    this.captureEpoch = crypto.randomUUID();
    this.frameSeq = 0;
    this.lastSource = -1;
    this.lastStartedAt = -Infinity;
    this.calibration = null;
    this.background = "background_unverified";
    this.tracker.reset();
    this.rules.reset();
    this.guard.reset();
    this.completionTimes = [];
    this.latest = null;
    this.onReset();
  }
  async start(
    profile: 416 | 320 = 416,
    file?: File | null,
    remote?: RemoteDetector,
  ) {
    this.pause(false);
    const generation = ++this.generation;
    this.browserProfile = profile;
    this.sourceFrames = 0;
    this.skippedFrames = 0;
    this.sourceTimes = [];
    if (remote?.ready) this.attachRemote(remote);
    if (file !== undefined) this.sourceFile = file;
    if (file === null) {
      if (this.replayUrl) URL.revokeObjectURL(this.replayUrl);
      this.replayUrl = null;
      this.video.removeAttribute("src");
      this.video.load();
    }
    this.performancePolicy = new AdaptivePerformance(profile);
    this.sourceStalled = false;
    this.onProfile(profile, false);
    this.resetEpoch();
    this.onStatus("Preparing camera");
    try {
      if (this.sourceFile) {
        this.sourceMode = "replay_video";
        if (this.replayUrl) URL.revokeObjectURL(this.replayUrl);
        this.replayUrl = URL.createObjectURL(this.sourceFile);
        this.video.src = this.replayUrl;
      } else {
        this.sourceMode = "live_camera";
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error("Camera needs HTTPS and a supported browser");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (generation !== this.generation) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        this.stream = stream;
        this.video.srcObject = stream;
        stream.getVideoTracks().forEach((t) =>
          t.addEventListener("ended", () => {
            if (this.running) {
              this.pause();
              this.onError("Camera permission or source was lost");
            }
          }),
        );
      }
      await this.video.play();
      if (generation !== this.generation) return;
      if (!this.remote?.ready) {
        this.onInferenceMode("Browser AI");
        this.onStatus("Loading detector");
        this.detector?.dispose();
        this.detector = new DetectorClient();
        await this.detector.load(profile, (p) =>
          this.onStatus(
            p.total
              ? `Loading detector · ${Math.round((p.loaded / p.total) * 100)}%`
              : "Loading detector",
          ),
        );
      }
      if (generation !== this.generation) return;
      this.running = true;
      this.lastCompletedAt = performance.now();
      this.onStatus(this.sourceMode === "replay_video" ? "Replay" : "Live");
      this.schedule();
    } catch (error) {
      if (generation !== this.generation) return;
      this.pause(false);
      this.onStatus("Unavailable");
      this.onError(
        error instanceof Error ? error.message : "Camera or model unavailable",
      );
    }
  }
  private attachRemote(remote: RemoteDetector) {
    this.remote?.close();
    this.remote = remote;
    remote.onUnavailable = (reason) => {
      if (this.remote === remote)
        void this.useBrowser(`${reason} · Browser fallback`);
    };
    this.onInferenceMode("GPU AI · Online");
  }
  useGpu(remote: RemoteDetector) {
    if (!this.running || this.switching) {
      remote.close();
      return;
    }
    if (!remote.ready) throw new Error("GPU not ready");
    this.attachRemote(remote);
    this.detector?.dispose();
    this.detector = null;
    this.resetEpoch();
  }
  async useBrowser(reason = "Browser AI") {
    this.remote?.close();
    this.remote = null;
    this.resetEpoch();
    this.onInferenceMode(reason);
    if (!this.running) return;
    const generation = this.generation;
    this.switching = true;
    this.onStatus("Loading detector · browser fallback");
    try {
      this.detector?.dispose();
      this.detector = new DetectorClient();
      await this.detector.load(this.browserProfile);
      if (generation !== this.generation || !this.running) return;
      this.performancePolicy = new AdaptivePerformance(this.browserProfile);
      this.lastCompletedAt = performance.now();
      this.onStatus(this.sourceMode === "replay_video" ? "Replay" : "Live");
    } catch {
      if (generation === this.generation) {
        this.pause();
        this.onError("Browser fallback unavailable. Resume to retry.");
      }
    } finally {
      if (generation === this.generation) this.switching = false;
    }
  }
  checkSourceHealth(now = performance.now()) {
    if (
      this.running &&
      !this.busy &&
      !this.sourceStalled &&
      now - this.lastCompletedAt > 5000
    ) {
      this.sourceStalled = true;
      this.resetEpoch();
      this.onStatus("Source stalled");
    }
  }
  private schedule() {
    if (!this.running) return;
    if ("requestVideoFrameCallback" in this.video)
      this.callbackId = this.video.requestVideoFrameCallback(
        (_now, metadata) => {
          this.schedule();
          void this.analyze(metadata.mediaTime * 1000);
        },
      );
    else
      this.fallbackTimer = setTimeout(() => {
        this.schedule();
        void this.analyze(this.video.currentTime * 1000);
      }, 50);
  }
  private gray(canvas: HTMLCanvasElement) {
    const small = document.createElement("canvas");
    small.width = 160;
    small.height = Math.max(
      48,
      Math.round((160 * canvas.height) / canvas.width),
    );
    const ctx = small.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(canvas, 0, 0, small.width, small.height);
    const rgba = ctx.getImageData(0, 0, small.width, small.height).data;
    const gray = new Uint8Array(small.width * small.height);
    for (let i = 0; i < gray.length; i++)
      gray[i] =
        rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114;
    return { gray, width: small.width, height: small.height };
  }
  private exclusions(boxes: [number, number, number, number][]) {
    const zone = this.calibration?.zone;
    if (!zone) return boxes;
    return [
      ...boxes,
      [
        Math.min(...zone.map((p) => p[0])),
        Math.min(...zone.map((p) => p[1])),
        Math.max(...zone.map((p) => p[0])),
        Math.max(...zone.map((p) => p[1])),
      ] as [number, number, number, number],
    ];
  }
  calibrate(calibration: Calibration, frozen: CompletedFrame) {
    if (
      !this.latest ||
      calibration.captureEpoch !== this.captureEpoch ||
      frozen.result.captureEpoch !== this.captureEpoch
    )
      throw new Error("Source changed. Capture calibration again.");
    this.calibration = calibration;
    this.mounted = true;
    const g = this.gray(frozen.canvas);
    this.guard.capture(
      g.gray,
      g.width,
      g.height,
      this.exclusions(frozen.result.tracks.map((t) => t.bbox)),
    );
    this.background = "background_unverified";
    this.tracker.invalidateMeasurements();
    this.rules.invalidateContinuity();
  }
  private async analyze(sourceTimeMs: number) {
    this.sourceFrames++;
    const received = performance.now();
    this.sourceTimes.push(received);
    this.sourceTimes = this.sourceTimes
      .filter((t) => received - t <= 5000)
      .slice(-600);
    if (this.busy || this.switching) this.skippedFrames++;
    if (
      !this.running ||
      this.busy ||
      this.switching ||
      (!this.detector && !this.remote?.ready) ||
      !this.video.videoWidth
    )
      return;
    const geometry = `${this.video.videoWidth}:${this.video.videoHeight}`;
    if (
      this.geometry !== geometry ||
      sourceTimeMs < this.lastSource ||
      (sourceTimeMs - this.lastSource > 2000 && this.lastSource >= 0)
    ) {
      this.resetEpoch();
      this.geometry = geometry;
    }
    if (sourceTimeMs === this.lastSource) return;
    this.lastSource = sourceTimeMs;
    if (
      performance.now() - this.lastStartedAt <
      (this.remote?.diagnostics.intervalMs ?? this.performancePolicy.intervalMs)
    )
      return;
    this.lastStartedAt = performance.now();
    this.busy = true;
    const job = Symbol();
    this.activeJob = job;
    const generation = this.generation;
    const epoch = this.captureEpoch;
    const started = performance.now();
    const canvas = document.createElement("canvas");
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    if (canvas.width * canvas.height > 16_777_216) {
      this.busy = false;
      this.pause();
      this.onError(
        "Source resolution is too large. Choose a video at 4K or below.",
      );
      return;
    }
    canvas.getContext("2d")!.drawImage(this.video, 0, 0);
    const capturedAtIso = new Date().toISOString();
    const policy = structuredClone(this.policy);
    const frameSeq = this.frameSeq++;
    const remote = this.remote;
    try {
      let output: DetectionResult;
      if (remote) {
        const result = await remote.detect(canvas, {
          sourceId: this.sourceId,
          captureEpoch: epoch,
          frameSeq,
          frameId: `${epoch}:${frameSeq}`,
          sourceTimeMs,
          sourceWidth: canvas.width,
          sourceHeight: canvas.height,
        });
        output = {
          detections: result.detections,
          modelId: result.modelId,
          modelSha256: result.modelSha256,
          executionProvider: result.runtime,
          profile: result.inputSize,
          inferenceMs: result.metrics.inferenceMs,
        };
      } else
        output = await this.detector!.detect(await createImageBitmap(canvas));
      if (
        generation !== this.generation ||
        epoch !== this.captureEpoch ||
        !this.running
      )
        return;
      const now = performance.now();
      this.completionTimes.push(now);
      this.completionTimes = this.completionTimes.filter(
        (t) => now - t <= 5000,
      );
      const analysisHz =
        this.completionTimes.length > 1
          ? ((this.completionTimes.length - 1) * 1000) /
            (now - this.completionTimes[0])
          : 0;
      if (this.calibration) {
        const g = this.gray(canvas);
        this.background = this.guard.check(
          g.gray,
          g.width,
          g.height,
          this.exclusions(output.detections.map((d) => d.bbox)),
        );
        if (this.background !== "verified") {
          this.rules.invalidateContinuity();
        }
        if (this.background === "camera_moved") this.calibration = null;
      }
      const trackingStarted = performance.now();
      const tracked = this.tracker.update(
        output.detections,
        sourceTimeMs,
        epoch,
        !!this.calibration && this.mounted && this.background === "verified",
      );
      this.trackingMs = performance.now() - trackingStarted;
      const counts = emptyCounts();
      const candidates: CompletedFrame["candidates"] = [];
      const tracks = tracked.map((track) => {
        if (track.observed) counts[track.className]++;
        const speed = estimateSpeed(track, {
          calibration: this.calibration,
          captureEpoch: epoch,
          frameWidth: canvas.width,
          frameHeight: canvas.height,
          mounted: this.mounted,
          background: this.background,
        });
        const rule = this.rules.update(
          track.trackId,
          epoch,
          sourceTimeMs,
          speed.speedMps,
          policy,
        );
        if (rule.episodeKey)
          candidates.push({
            trackId: track.trackId,
            episodeKey: rule.episodeKey,
            estimate: speed,
          });
        return {
          trackId: track.trackId,
          className: track.className,
          score: track.score,
          bbox: track.bbox,
          observed: track.observed,
          speedMps: speed.speedMps,
          speedStatus:
            speed.speedMps === null
              ? ("unavailable" as const)
              : ("valid_estimate" as const),
          speedReason: speed.reason,
          ruleState: rule.ruleState,
        };
      });
      const speeds = tracks
        .filter((t) => t.speedMps !== null)
        .map((t) => t.speedMps!);
      const result = FrameSchema.parse({
        v: 2,
        frameId: `${epoch}:${frameSeq}`,
        sourceId: this.sourceId,
        captureEpoch: epoch,
        frameSeq,
        sourceMode: this.sourceMode,
        sourceTimeMs,
        capturedAtIso,
        frameWidth: canvas.width,
        frameHeight: canvas.height,
        modelId: output.modelId,
        modelSha256: output.modelSha256,
        detectorProfile: String(output.profile),
        executionProvider: output.executionProvider,
        trackerVersion: TRACKER_VERSION,
        calibrationVersion: this.calibration?.version ?? null,
        policyVersion: policy.version,
        inferenceMs: output.inferenceMs,
        analysisHz,
        tracks,
        stats: {
          counts,
          validSpeedCount: speeds.length,
          averageSpeedMps: speeds.length
            ? speeds.reduce((a, b) => a + b, 0) / speeds.length
            : null,
        },
      });
      const jpeg = await sampledJpeg(canvas);
      if (generation !== this.generation || epoch !== this.captureEpoch) return;
      const frame: CompletedFrame = {
        result,
        policy,
        canvas,
        jpeg: jpeg.blob,
        jpegWidth: jpeg.width,
        jpegHeight: jpeg.height,
        processingMs: performance.now() - started,
        candidates,
      };
      this.latest = frame;
      this.lastCompletedAt = performance.now();
      this.sourceStalled = false;
      this.onStatus(this.sourceMode === "replay_video" ? "Replay" : "Live");
      this.onFrame(frame);
      if (!remote && this.performancePolicy.observe(frame.processingMs)) {
        this.browserProfile = 320;
        this.resetEpoch();
        this.onProfile(320, true);
        this.onStatus("Loading detector · adapting to 320");
        await this.detector!.load(320);
        if (generation !== this.generation || !this.running) return;
        this.lastCompletedAt = performance.now();
        this.onStatus(this.sourceMode === "replay_video" ? "Replay" : "Live");
      }
    } catch (error) {
      if (epoch !== this.captureEpoch) return;
      if (error instanceof GpuDroppedFrameError) return;
      if (remote && generation === this.generation && this.running) {
        if (this.remote === remote)
          await this.useBrowser("GPU unavailable · Browser fallback");
        return;
      }
      if (generation === this.generation && this.running) {
        this.pause();
        this.onError(
          error instanceof Error ? error.message : "Analysis failed",
        );
      }
    } finally {
      if (this.activeJob === job) {
        this.busy = false;
        this.activeJob = null;
      }
      if (this.latest?.canvas !== canvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
    }
  }
  pause(notify = true) {
    this.running = false;
    this.generation++;
    this.switching = false;
    this.busy = false;
    this.activeJob = null;
    this.remote?.close();
    this.remote = null;
    if (this.callbackId) this.video.cancelVideoFrameCallback?.(this.callbackId);
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.detector?.dispose();
    this.detector = null;
    this.resetEpoch();
    if (notify) this.onStatus("Paused");
  }
  end() {
    this.pause(false);
    this.video.removeAttribute("src");
    this.video.load();
    if (this.replayUrl) URL.revokeObjectURL(this.replayUrl);
    this.replayUrl = null;
    this.sourceFile = null;
    this.latest = null;
    this.sourceId = crypto.randomUUID();
    this.policy = newPolicy();
    this.mounted = false;
  }
}
