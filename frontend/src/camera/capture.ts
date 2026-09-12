import { DetectorClient } from "../inference/client";
import {
  TimeAwareTrackerV2,
  TRACKER_V2_VERSION,
} from "../tracking/trackerV2";
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
import { GPU_LIMITS, LIMITS } from "../../../shared/src/limits";
import { AdaptivePerformance } from "./performance";
import {
  FrameClock,
  type FrameSample,
  type FrameTimingSource,
} from "./frameClock";
import {
  frameRateNote,
  frameRateOptions,
  type FrameRateChoice,
  type FrameRateStatus,
} from "./frameRate";
import {
  RemoteDetector,
  GpuDroppedFrameError,
  type GpuDiagnostics,
} from "../inference/remote";
import type { DetectionResult } from "../inference/types";
export interface CompletedFrame {
  result: FrameResult;
  /** Internal tracker fact; never serialized or sent through the relay. */
  ambiguousTrackIds: ReadonlySet<number>;
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
  /**
   * Every track's speed estimate this frame, valid or not. Speed validation
   * needs the estimate for a chosen vehicle, not only for rule-triggered ones.
   */
  estimates: Map<number, SpeedEstimate>;
}
/** Shown when a visible source stops producing completed analysis. */
export const STALLED_STATUS = "Camera analysis stalled · retrying";
/** No frame callback within this window while the source is playing is a stall. */
const CALLBACK_STALL_MS = 2000;
/** No completed analysis within this window is an analysis stall. */
const ANALYSIS_STALL_MS = 5000;
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
  /**
   * The vehicle the operator has tapped, or null. Held here rather than in
   * React state because the analysis loop stamps it into every frame and the
   * plate workflow needs it without a re-render.
   */
  selectedTrackId: number | null = null;
  onFrame = (_frame: CompletedFrame) => {};
  onStatus = (_state: string) => {};
  onError = (_message: string) => {};
  onReset = () => {};
  onProfile = (_profile: 416 | 320, _automatic: boolean) => {};
  onInferenceMode = (_mode: string) => {};
  remote: RemoteDetector | null = null;
  private switching = false;
  private browserProfile: 416 | 320 = 416;
  private sourceFrames = 0;
  private skippedFrames = 0;
  private duplicateFrames = 0;
  private acceptedFrames = 0;
  private trackingMs = 0;
  private sourceTimes: number[] = [];
  private acceptedTimes: number[] = [];
  get operationVersion() {
    return this.generation;
  }
  private hz(times: number[]) {
    return times.length > 1
      ? ((times.length - 1) * 1000) / Math.max(1, times.at(-1)! - times[0]!)
      : 0;
  }
  /** Capture-side frame clock health. Available with or without a GPU worker. */
  get frameDiagnostics(): {
    sourceMode: "live_camera" | "replay_video";
    scheduler: "frame_callback" | "timer";
    sourceFrames: number;
    acceptedFrames: number;
    duplicateFrames: number;
    skippedFrames: number;
    sourceHz: number;
    acceptedHz: number;
    analysisHz: number;
    presentedFrames: number | null;
    timingSource: FrameTimingSource | null;
    sourceTimeMs: number;
    frameSeq: number;
    trackingMs: number;
    inFlight: number;
    maxInFlight: number;
    /** Completions dropped because a newer frame had already committed. */
    supersededResults: number;
    /** Completions dropped for exceeding the result-age ceiling. */
    staleResults: number;
  } {
    return {
      sourceMode: this.sourceMode,
      scheduler: this.frameCallbacks ? "frame_callback" : "timer",
      sourceFrames: this.sourceFrames,
      acceptedFrames: this.acceptedFrames,
      duplicateFrames: this.duplicateFrames,
      skippedFrames: this.skippedFrames,
      inFlight: this.inFlightJobs.size,
      maxInFlight: this.maxInFlight,
      supersededResults: this.supersededResults,
      staleResults: this.staleResults,
      sourceHz: this.hz(this.sourceTimes),
      acceptedHz: this.hz(this.acceptedTimes),
      analysisHz: this.hz(this.completionTimes),
      presentedFrames: this.frameClock.presentedFrames,
      timingSource: this.frameClock.timingSource,
      sourceTimeMs: this.frameClock.sourceTimeMs,
      frameSeq: this.frameSeq,
      trackingMs: this.trackingMs,
    };
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
          sourceHz: this.hz(this.sourceTimes),
        }
      : null;
  }
  /**
   * Operating mode, as the product presents it.
   *
   * Speed is a property of the setup, not of a toggle: it requires a calibrated
   * homography for this exact epoch and geometry, a confirmed stationary
   * capture, and a background the motion guard still recognises. The operator
   * declares intent by calibrating; the motion guard keeps authority, so a
   * camera that is picked up loses speed on the next analysed frame even though
   * nothing was toggled.
   */
  get operatingMode(): {
    operating: "handheld" | "mounted";
    speedActive: boolean;
    reason: string;
  } {
    const operating = this.mounted ? "mounted" : "handheld";
    if (!this.mounted)
      return { operating, speedActive: false, reason: "handheld" };
    if (this.background === "camera_moved")
      return { operating, speedActive: false, reason: "camera_moved" };
    const c = this.calibration;
    if (!c) return { operating, speedActive: false, reason: "not_calibrated" };
    if (
      c.captureEpoch !== this.captureEpoch ||
      !c.stationaryConfirmed ||
      c.frameWidth !== (this.latest?.result.frameWidth ?? c.frameWidth) ||
      c.frameHeight !== (this.latest?.result.frameHeight ?? c.frameHeight)
    )
      return { operating, speedActive: false, reason: "calibration_invalid" };
    if (this.background !== "verified")
      return { operating, speedActive: false, reason: this.background };
    return { operating, speedActive: true, reason: "speed_active" };
  }
  /** Operator frame-rate request; "auto" leaves the track's own choice alone. */
  frameRate: FrameRateChoice = "auto";
  /** Operator analysis-rate request in FPS; "auto" uses the measured controller. */
  analysisRate: "auto" | number = "auto";
  private track: MediaStreamTrack | null = null;
  private readonly baseVideoConstraints: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };
  /** Live presentation time now. Display-side overlay age only. */
  sourceTimeNow(now = performance.now()) {
    if (this.sourceMode === "replay_video")
      return Number.isFinite(this.video.currentTime)
        ? this.video.currentTime * 1000
        : this.frameClock.sourceTimeMs;
    return this.frameClock.liveElapsedMs(now) ?? this.frameClock.sourceTimeMs;
  }
  get cameraFrameRate(): FrameRateStatus {
    const track = this.track;
    const settings = track?.getSettings?.() ?? null;
    const capabilities = track?.getCapabilities?.() ?? null;
    const actual =
      typeof settings?.frameRate === "number" &&
      Number.isFinite(settings.frameRate)
        ? settings.frameRate
        : null;
    const options = frameRateOptions(capabilities, settings);
    return {
      requested: this.frameRate,
      actual,
      options,
      supported: !!track && typeof track.applyConstraints === "function",
      note: frameRateNote(this.frameRate, actual),
    };
  }
  /**
   * Ask the track for a rate and report what it actually selected. A camera
   * reconfiguration invalidates timing continuity, so measurement restarts.
   */
  async applyFrameRate(choice: FrameRateChoice) {
    const track = this.track;
    this.frameRate = choice;
    if (!track?.applyConstraints)
      return { applied: false, status: this.cameraFrameRate };
    try {
      await track.applyConstraints(
        choice === "auto"
          ? { ...this.baseVideoConstraints }
          : { ...this.baseVideoConstraints, frameRate: { ideal: choice } },
      );
    } catch {
      return { applied: false, status: this.cameraFrameRate };
    }
    if (this.running) this.resetEpoch();
    return { applied: true, status: this.cameraFrameRate };
  }
  /** Submission spacing: an operator target may slow analysis, never outrun safety. */
  targetIntervalMs() {
    const automatic =
      this.remote?.diagnostics.intervalMs ?? this.performancePolicy.intervalMs;
    if (this.analysisRate === "auto") return automatic;
    const requested = 1000 / this.analysisRate;
    return Math.max(
      requested,
      this.remote ? this.remote.diagnostics.backoffMs : 16,
    );
  }
  private detector: DetectorClient | null = null;
  private tracker = new TimeAwareTrackerV2();
  private guard = new BackgroundGuard();
  private rules = new CandidateRules();
  private stream: MediaStream | null = null;
  private running = false;
  /**
   * Frames whose analysis has started and not finished. Bounded by maxInFlight;
   * frames arriving at capacity are dropped, never queued, so the newest useful
   * frame is always the one submitted.
   */
  private inFlightJobs = new Set<symbol>();
  /**
   * Highest frameSeq already committed to the tracker in the current epoch.
   * With several frames in flight a completion can arrive after a newer one;
   * such a result is superseded and must never reach tracking, speed or rules.
   */
  private lastCommittedSeq = -1;
  private supersededResults = 0;
  private staleResults = 0;
  /** Browser inference is one ONNX worker thread: queuing only adds latency. */
  get maxInFlight() {
    return this.remote?.maxInFlight ?? 1;
  }
  private get atCapacity() {
    return this.inFlightJobs.size >= this.maxInFlight;
  }
  private generation = 0;
  private frameSeq = 0;
  private frameClock = new FrameClock();
  private lastCallbackAt = -Infinity;
  /** Frame callbacks are preferred; the timer is a bounded, one-way recovery. */
  private frameCallbacks = true;
  private schedulerRecovered = false;
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
    // Timing history never crosses an epoch: a new epoch is a new timeline.
    this.frameClock.reset();
    this.lastStartedAt = -Infinity;
    this.calibration = null;
    this.background = "background_unverified";
    this.tracker.reset();
    this.rules.reset();
    this.guard.reset();
    this.completionTimes = [];
    this.lastCommittedSeq = -1;
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
    this.duplicateFrames = 0;
    this.acceptedFrames = 0;
    this.sourceTimes = [];
    this.acceptedTimes = [];
    this.frameCallbacks = true;
    this.schedulerRecovered = false;
    this.lastCallbackAt = -Infinity;
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
        this.track = stream.getVideoTracks()[0] ?? null;
        if (this.frameRate !== "auto")
          await this.applyFrameRate(this.frameRate);
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
      // Armed here so a frame callback that never fires is still detected.
      this.lastCallbackAt = performance.now();
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
    if (!this.running) return;
    // A visible, playing source whose frame callbacks stopped gets exactly one
    // recovery: the timer scheduler replaces them. The two never run together.
    if (
      this.frameCallbacks &&
      !this.schedulerRecovered &&
      this.lastCallbackAt > -Infinity &&
      now - this.lastCallbackAt > CALLBACK_STALL_MS &&
      !this.video.paused &&
      this.video.readyState >= 2
    ) {
      this.frameCallbacks = false;
      this.schedulerRecovered = true;
      this.lastCallbackAt = now;
      this.onStatus(STALLED_STATUS);
      this.schedule();
      return;
    }
    if (
      !this.inFlightJobs.size &&
      !this.sourceStalled &&
      now - this.lastCompletedAt > ANALYSIS_STALL_MS
    ) {
      this.sourceStalled = true;
      this.resetEpoch();
      this.onStatus(STALLED_STATUS);
    }
  }
  private cancelScheduled() {
    if (this.callbackId) {
      this.video.cancelVideoFrameCallback?.(this.callbackId);
      this.callbackId = 0;
    }
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }
  private schedule() {
    this.cancelScheduled();
    if (!this.running) return;
    if (this.frameCallbacks && "requestVideoFrameCallback" in this.video)
      this.callbackId = this.video.requestVideoFrameCallback(
        (now, metadata) => {
          this.callbackId = 0;
          this.lastCallbackAt = performance.now();
          this.schedule();
          void this.analyze({
            now,
            metadata,
            currentTime: this.video.currentTime,
          });
        },
      );
    else {
      this.frameCallbacks = false;
      this.fallbackTimer = setTimeout(() => {
        this.fallbackTimer = null;
        this.lastCallbackAt = performance.now();
        this.schedule();
        void this.analyze({
          now: performance.now(),
          currentTime: this.video.currentTime,
        });
      }, 50);
    }
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
  private async analyze(sample: FrameSample) {
    this.sourceFrames++;
    const received = performance.now();
    this.sourceTimes.push(received);
    this.sourceTimes = this.sourceTimes
      .filter((t) => received - t <= 5000)
      .slice(-600);
    if (this.atCapacity || this.switching) this.skippedFrames++;
    if (
      !this.running ||
      this.atCapacity ||
      this.switching ||
      (!this.detector && !this.remote?.ready) ||
      !this.video.videoWidth
    )
      return;
    let tick = this.frameClock.nextFrame(this.sourceMode, sample);
    if (!tick.accept) {
      this.duplicateFrames++;
      return;
    }
    const geometry = `${this.video.videoWidth}:${this.video.videoHeight}`;
    if (this.geometry !== geometry || tick.discontinuity) {
      // resetEpoch clears the clock, so the same frame is re-read on the fresh
      // timeline: frame 0 of an epoch always carries that epoch's first time.
      this.resetEpoch();
      this.geometry = geometry;
      tick = this.frameClock.nextFrame(this.sourceMode, sample);
      if (!tick.accept) {
        this.duplicateFrames++;
        return;
      }
    }
    const sourceTimeMs = tick.sourceTimeMs;
    this.acceptedFrames++;
    this.acceptedTimes.push(received);
    this.acceptedTimes = this.acceptedTimes
      .filter((t) => received - t <= 5000)
      .slice(-600);
    if (performance.now() - this.lastStartedAt < this.targetIntervalMs())
      return;
    this.lastStartedAt = performance.now();
    const job = Symbol();
    this.inFlightJobs.add(job);
    const generation = this.generation;
    const epoch = this.captureEpoch;
    const started = performance.now();
    const canvas = document.createElement("canvas");
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    if (canvas.width * canvas.height > 16_777_216) {
      this.inFlightJobs.delete(job);
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
      // Ordering gate. Several frames may be in flight, so a completion can
      // arrive after a newer one has already advanced the tracker. Committing
      // it would rewind track history and corrupt every source-time derived
      // quantity, so a superseded result is counted and discarded here —
      // before tracking, speed, rules, counts, evidence or display.
      if (frameSeq <= this.lastCommittedSeq) {
        this.supersededResults++;
        return;
      }
      // Freshness gate. A result older than the ceiling can never be presented
      // as live, so it is discarded rather than used as a measurement input.
      // Its source time would still be geometrically valid; the ceiling is a
      // deliberate safety bound, documented in docs/LATENCY_POLICY.md.
      if (now - started > GPU_LIMITS.maxResultAgeMs) {
        this.staleResults++;
        return;
      }
      this.lastCommittedSeq = frameSeq;
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
      const estimates = new Map<number, SpeedEstimate>();
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
        estimates.set(track.trackId, speed);
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
          motion: track.motion,
          trackState: track.state,
          observedMs: Math.max(0, track.lastSeenMs - track.firstSeenMs),
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
        trackerVersion: TRACKER_V2_VERSION,
        calibrationVersion: this.calibration?.version ?? null,
        policyVersion: policy.version,
        inferenceMs: output.inferenceMs,
        analysisHz,
        tracks,
        mode: this.operatingMode,
        // A selection only travels while the vehicle is still on screen, so a
        // viewer never highlights a box that no longer exists.
        selectedTrackId: tracks.some((t) => t.trackId === this.selectedTrackId)
          ? this.selectedTrackId
          : null,
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
      // The tracker already consumed this frame in order. Publishing is a
      // separate decision: a newer frame may have committed during the encode,
      // and the display must never step backwards.
      if (frameSeq < this.lastCommittedSeq) {
        this.supersededResults++;
        return;
      }
      const frame: CompletedFrame = {
        result,
        ambiguousTrackIds: new Set(
          tracked
            .filter((track) => track.ambiguous)
            .map((track) => track.trackId),
        ),
        policy,
        canvas,
        jpeg: jpeg.blob,
        jpegWidth: jpeg.width,
        jpegHeight: jpeg.height,
        processingMs: performance.now() - started,
        candidates,
        estimates,
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
      this.inFlightJobs.delete(job);
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
    this.inFlightJobs.clear();
    this.lastCommittedSeq = -1;
    this.remote?.close();
    this.remote = null;
    this.cancelScheduled();
    this.lastCallbackAt = -Infinity;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
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
    this.frameRate = "auto";
    this.analysisRate = "auto";
  }
}
