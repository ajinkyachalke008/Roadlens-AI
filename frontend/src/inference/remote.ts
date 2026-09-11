import { GPU_LIMITS, PLATE_LIMITS } from "../../../shared/src/limits";
import {
  encodePlateFrame,
  samePlateRequest,
  type PlateDescriptor,
  type PlateIdentity,
  type PlateResult,
} from "../../../shared/src/plates";
import {
  encodeGpuFrame,
  GpuServerMessageSchema,
  sameGpuFrame,
  type GpuDescriptor,
  type GpuIdentity,
  type GpuMetrics,
  type GpuResult,
} from "../../../shared/src/gpu";
import { apiBase, type Room } from "../transport/client";

export type CaptureIdentity = Omit<
  GpuIdentity,
  "roomId" | "encodedWidth" | "encodedHeight"
>;
export interface GpuDiagnostics {
  submitted: number;
  completed: number;
  dropped: number;
  bytes: number;
  encodeMs: number;
  resultAgeMs: number;
  rttMs: number | null;
  worker: GpuMetrics | null;
  intervalMs: number;
  /** Congestion floor: raised only by drops, decayed only by completions. */
  backoffMs: number;
  submittedHz: number;
  resultHz: number;
  /** Frames submitted and not yet resolved. Never exceeds maxInFlight. */
  inFlight: number;
  maxInFlight: number;
}
export class GpuUnavailableError extends Error {}
/** Plate recognition is absent or refused this request; traffic is unaffected. */
export class PlateUnavailableError extends Error {}
export type PlateRequest = Omit<
  PlateIdentity,
  "roomId" | "requestId"
> & {
  /** Vehicle box in the source frame, normalised, already padded. */
  crop: { x: number; y: number; width: number; height: number };
};
/** Transient congestion drops this frame without invalidating the GPU connection. */
export class GpuDroppedFrameError extends Error {}
const minimumSendIntervalMs = 1000 / GPU_LIMITS.maxHz + 5;
interface FrameOperation {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  canvas: HTMLCanvasElement;
  started: number;
  /** Set once this operation has actually submitted an identity. */
  frameId: string | null;
}

interface PendingJob {
  identity: GpuIdentity;
  resolve: (value: GpuResult) => void;
  reject: (error: Error) => void;
  started: number;
}

/**
 * Bounded analysis pipeline, at most `GPU_LIMITS.maxInFlight` outstanding frames.
 * CameraCapture retains each frame's exact canvas until its promise completes.
 * Results may only be correlated by exact frame identity, never by arrival order.
 */
export class RemoteDetector {
  descriptor: GpuDescriptor | null = null;
  /** Non-null only while a worker with a loaded plate pipeline is leased. */
  plateDescriptor: PlateDescriptor | null = null;
  ready = false;
  private platePending = new Map<
    string,
    {
      identity: PlateIdentity;
      resolve: (value: PlateResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private lastPlateSentAt = -Infinity;
  get plateAvailable() {
    return !!this.plateDescriptor && this.ready && !this.disposed;
  }
  get plateInFlight() {
    return this.platePending.size;
  }
  private measurements: Omit<
    GpuDiagnostics,
    "submittedHz" | "resultHz" | "inFlight" | "maxInFlight"
  > = {
    backoffMs: 1000 / GPU_LIMITS.maxHz + 5,
    submitted: 0,
    completed: 0,
    dropped: 0,
    bytes: 0,
    encodeMs: 0,
    resultAgeMs: 0,
    rttMs: null,
    worker: null,
    intervalMs: 100,
  };
  private submittedTimes: number[] = [];
  private completedTimes: number[] = [];
  get diagnostics(): GpuDiagnostics {
    const now = performance.now();
    this.submittedTimes = this.submittedTimes.filter(
      (time) => now - time <= 5000,
    );
    this.completedTimes = this.completedTimes.filter(
      (time) => now - time <= 5000,
    );
    const rate = (times: number[]) =>
      times.length > 1 && times.at(-1)! > times[0]!
        ? ((times.length - 1) * 1000) / (times.at(-1)! - times[0]!)
        : 0;
    return {
      ...this.measurements,
      submittedHz: rate(this.submittedTimes),
      resultHz: rate(this.completedTimes),
      inFlight: this.pending.size,
      maxInFlight: this.maxInFlight,
    };
  }
  onUnavailable = (_reason: string) => {};
  private socket: WebSocket | null = null;
  private disposed = false;
  /** True only while a frame is being scaled and JPEG-encoded, not while it flies. */
  private encoding = false;
  // Connection-wide: source/seek epochs must not reset the relay's rate ceiling.
  private lastSuccessfulSendAt = -Infinity;
  /** Every unfinished encode/round trip. Each owns its own abort and timer. */
  private operations = new Set<FrameOperation>();
  /** Submitted, unresolved frames by frameId. Bounded by maxInFlight. */
  private pending = new Map<string, PendingJob>();
  /**
   * Pipeline depth actually used on this connection. It starts at the protocol
   * ceiling and drops to 1 permanently if the relay proves it only accepts one
   * outstanding frame — which is exactly what a relay deployed before this
   * client does. `gpu.status` is a `.strict()` schema, so the depth cannot be
   * advertised without breaking older clients; discovering it from refusals
   * needs no protocol change and makes deployment order harmless.
   */
  private effectiveMaxInFlight: number = GPU_LIMITS.maxInFlight;
  /** Refusals seen while more than one frame was outstanding. */
  private concurrentBusy = 0;
  /**
   * Occasional refusals are races against the relay's own send-rate floor, not
   * evidence of depth 1. Three systematic refusals are.
   */
  private static readonly busyBeforeDowngrade = 3;
  get maxInFlight() {
    return this.effectiveMaxInFlight;
  }
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private ping: { nonce: number; started: number } | null = null;
  constructor(
    private room: Room,
    readonly edge: 640 | 960 = 640,
  ) {}
  connect(): Promise<void> {
    if (this.socket || this.disposed)
      return Promise.reject(
        new GpuUnavailableError("GPU connection unavailable"),
      );
    const url = new URL(apiBase());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/gpu";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => fail("GPU connection timed out"),
        GPU_LIMITS.helloMs,
      );
      const fail = (reason: string) => {
        clearTimeout(timer);
        reject(new GpuUnavailableError(reason));
        this.unavailable(reason);
      };
      const ws = new WebSocket(url);
      this.socket = ws;
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            v: 1,
            type: "gpu.hello",
            role: "camera",
            roomId: this.room.roomId,
            token: this.room.ownerToken,
          }),
        );
      ws.onmessage = (event) => {
        if (this.disposed) return;
        try {
          if (
            typeof event.data !== "string" ||
            new TextEncoder().encode(event.data).length > GPU_LIMITS.textBytes
          )
            throw new Error("Invalid GPU message");
          const m = GpuServerMessageSchema.parse(JSON.parse(event.data));
          if (m.type === "gpu.status") {
            if (m.state !== "ready") {
              fail(
                m.state === "busy" ? "GPU worker busy" : "GPU worker offline",
              );
              return;
            }
            this.descriptor = m.descriptor!;
            this.plateDescriptor = m.plate ?? null;
            this.ready = true;
            clearTimeout(timer);
            resolve();
            if (!this.heartbeat)
              this.heartbeat = setInterval(() => {
                if (
                  this.ping &&
                  performance.now() - this.ping.started > GPU_LIMITS.staleMs
                ) {
                  this.unavailable("GPU relay unavailable");
                  return;
                }
                if (!this.ping && ws.readyState === WebSocket.OPEN) {
                  this.ping = {
                    nonce: Math.floor(performance.now()),
                    started: performance.now(),
                  };
                  ws.send(
                    JSON.stringify({
                      v: 1,
                      type: "gpu.ping",
                      nonce: this.ping.nonce,
                    }),
                  );
                }
              }, 1000);
          } else if (m.type === "gpu.pong") {
            if (m.nonce === this.ping?.nonce) {
              this.measurements.rttMs = performance.now() - this.ping.started;
              this.ping = null;
            }
          } else if (m.type === "plate.error") {
            this.settlePlate(m.requestId, null, m.code);
          } else if (m.type === "plate.result") {
            this.settlePlate(m.requestId, m, null);
          } else if (m.type === "inference.error") {
            const job = this.pending.get(m.frameId);
            if (job && m.roomId === job.identity.roomId) {
              if (m.code === "busy") {
                // Refused while another frame was already outstanding: the
                // relay may be an older one that admits only a single frame.
                const concurrent = this.pending.size > 1;
                this.pending.delete(m.frameId);
                if (
                  concurrent &&
                  this.effectiveMaxInFlight > 1 &&
                  ++this.concurrentBusy >=
                    RemoteDetector.busyBeforeDowngrade
                ) {
                  this.effectiveMaxInFlight = 1;
                  // Capacity discovery, not congestion: the submission rate
                  // must not be penalised for learning the relay's depth.
                  this.measurements.dropped++;
                  job.reject(
                    new GpuDroppedFrameError(
                      "GPU accepts one frame at a time; frame dropped",
                    ),
                  );
                  return;
                }
                job.reject(this.drop("GPU worker busy; frame dropped"));
              } else this.unavailable("GPU analysis unavailable");
            }
          } else {
            const job = this.pending.get(m.frameId);
            // Duplicates, canceled work and unrelated IDs never get a retained image.
            if (!job || !sameGpuFrame(job.identity, m)) {
              this.measurements.dropped++;
              return;
            }
            if (
              !this.descriptor ||
              m.modelSha256 !== this.descriptor.modelSha256 ||
              m.modelId !== this.descriptor.modelId ||
              m.runtime !== this.descriptor.runtime ||
              m.inputSize !== this.descriptor.inputSize
            )
              throw new Error("GPU model changed");
            const age = performance.now() - job.started;
            if (age > GPU_LIMITS.frameTimeoutMs) {
              this.unavailable("GPU result expired");
              return;
            }
            this.pending.delete(m.frameId);
            this.measurements.completed++;
            this.completedTimes.push(performance.now());
            this.completedTimes = this.completedTimes.slice(-80);
            this.measurements.resultAgeMs = age;
            this.measurements.worker = m.metrics;
            // Bounded in-flight depth is the primary backpressure. To keep
            // `maxInFlight` frames outstanding on a cycle of `age`, submit every
            // `age / maxInFlight`; the 1.15 factor leaves headroom so the depth
            // is approached rather than exceeded, and drops stay rare.
            const desired = Math.max(
              minimumSendIntervalMs,
              Math.min(1000, (age * 1.15) / this.maxInFlight),
            );
            this.measurements.intervalMs = Math.max(
              minimumSendIntervalMs,
              this.measurements.intervalMs * 0.75 + desired * 0.25,
            );
            // A completed frame is evidence the path recovered.
            this.measurements.backoffMs = Math.max(
              minimumSendIntervalMs,
              this.measurements.backoffMs * 0.9,
            );
            job.resolve(m);
          }
        } catch {
          fail("Invalid GPU response");
        }
      };
      ws.onclose = () => fail("GPU worker disconnected");
      ws.onerror = () => fail("GPU worker unavailable");
    });
  }
  async detect(
    canvas: HTMLCanvasElement,
    identity: CaptureIdentity,
  ): Promise<GpuResult> {
    if (!this.ready || this.disposed || !this.socket)
      throw new GpuUnavailableError("GPU worker unavailable");
    // One encode at a time keeps the capture thread predictable; encoding is a
    // few milliseconds against a submission interval an order of magnitude larger.
    if (this.pending.size >= this.maxInFlight || this.encoding)
      throw this.drop("GPU worker busy; frame dropped");
    if (performance.now() - this.lastSuccessfulSendAt < minimumSendIntervalMs)
      throw this.drop("GPU send rate limited; frame dropped");
    this.encoding = true;
    const started = performance.now();
    const scaled = document.createElement("canvas");
    const operation: FrameOperation = {
      controller: new AbortController(),
      canvas: scaled,
      started,
      frameId: null,
      // Covers JPEG encoding, Blob reads and the network/GPU round trip together.
      timer: setTimeout(
        () => this.unavailable("GPU analysis timed out"),
        GPU_LIMITS.frameTimeoutMs,
      ),
    };
    this.operations.add(operation);
    try {
      const scale = Math.min(
        1,
        this.edge / Math.max(canvas.width, canvas.height),
      );
      scaled.width = Math.round(canvas.width * scale);
      scaled.height = Math.round(canvas.height * scale);
      scaled
        .getContext("2d")!
        .drawImage(canvas, 0, 0, scaled.width, scaled.height);
      let blob: Blob | null = null;
      for (const quality of [0.75, 0.6, 0.45, 0.3]) {
        blob = await this.waitForOperation(
          new Promise<Blob | null>((resolve) =>
            scaled.toBlob(resolve, "image/jpeg", quality),
          ),
          operation,
        );
        if (blob && blob.size <= GPU_LIMITS.jpegTarget) break;
      }
      if (!blob || blob.size > GPU_LIMITS.jpegBytes)
        throw new GpuUnavailableError("Analysis frame exceeds limit");
      const jpeg = new Uint8Array(
        await this.waitForOperation(blob.arrayBuffer(), operation),
      );
      if (
        !this.ready ||
        this.disposed ||
        this.socket.readyState !== WebSocket.OPEN
      )
        throw new GpuUnavailableError("GPU disconnected during capture");
      const frame: GpuIdentity = {
        ...identity,
        roomId: this.room.roomId,
        encodedWidth: scaled.width,
        encodedHeight: scaled.height,
      };
      const packet = encodeGpuFrame(
        {
          v: 1,
          type: "camera.frame",
          format: "image/jpeg",
          ...frame,
          imageLength: jpeg.length,
        },
        jpeg,
      );
      if (
        this.socket.bufferedAmount + packet.byteLength >
        GPU_LIMITS.messageBytes * this.maxInFlight
      )
        throw this.drop("GPU network is congested; frame dropped");
      if (performance.now() - this.lastSuccessfulSendAt < minimumSendIntervalMs)
        throw this.drop("GPU send rate limited; frame dropped");
      this.measurements.encodeMs = performance.now() - started;
      return await this.waitForOperation(
        new Promise<GpuResult>((resolve, reject) => {
          this.pending.set(frame.frameId, {
            identity: frame,
            resolve,
            reject,
            started,
          });
          operation.frameId = frame.frameId;
          this.socket!.send(packet.buffer as ArrayBuffer);
          // The capture thread is free the moment the packet is queued; only the
          // round trip remains, and that is what the in-flight bound governs.
          this.encoding = false;
          this.lastSuccessfulSendAt = performance.now();
          this.measurements.submitted++;
          this.submittedTimes.push(this.lastSuccessfulSendAt);
          this.submittedTimes = this.submittedTimes.slice(-80);
          this.measurements.bytes += packet.byteLength;
        }),
        operation,
      );
    } finally {
      clearTimeout(operation.timer);
      this.operations.delete(operation);
      // Whether it resolved, dropped or aborted, this identity is finished.
      if (operation.frameId) this.pending.delete(operation.frameId);
      // Idempotent: already cleared at send, still required on an early throw.
      this.encoding = false;
      scaled.width = 1;
      scaled.height = 1;
    }
  }
  private settlePlate(
    requestId: string,
    result: PlateResult | null,
    code: string | null,
  ) {
    const job = this.platePending.get(requestId);
    if (!job) return;
    // Correlate by exact identity. A reply whose track or epoch differs from
    // what was asked belongs to nothing this camera can still use.
    if (result && !samePlateRequest(job.identity, result)) return;
    this.platePending.delete(requestId);
    clearTimeout(job.timer);
    if (result) job.resolve(result);
    else job.reject(new PlateUnavailableError(code ?? "plate_failed"));
  }
  /**
   * Submit one vehicle crop for plate recognition.
   *
   * The crop is taken from `canvas`, which is the camera's full resolution
   * source frame rather than the downscaled analysis frame, because that is the
   * only place the plate pixels ever existed. Rejection is always cheap and
   * never invalidates the GPU connection: plate work is an enhancement.
   */
  async readPlate(
    canvas: HTMLCanvasElement,
    request: PlateRequest,
  ): Promise<PlateResult> {
    if (!this.plateAvailable || !this.socket)
      throw new PlateUnavailableError("Plate recognition unavailable");
    if (this.platePending.size >= PLATE_LIMITS.maxInFlight)
      throw new PlateUnavailableError("Plate recognition busy");
    if (performance.now() - this.lastPlateSentAt < PLATE_LIMITS.minIntervalMs)
      throw new PlateUnavailableError("Plate request rate limited");
    const { crop, ...identity } = request;
    const sourceWidth = canvas.width;
    const sourceHeight = canvas.height;
    const pixelWidth = Math.round(crop.width * sourceWidth);
    const pixelHeight = Math.round(crop.height * sourceHeight);
    if (
      Math.max(pixelWidth, pixelHeight) < PLATE_LIMITS.minCropEdge ||
      pixelWidth < 1 ||
      pixelHeight < 1
    )
      throw new PlateUnavailableError("Vehicle crop is too small to read");
    const scaled = document.createElement("canvas");
    try {
      // Never upscale here: enlarging on the phone would only cost bytes, and
      // the worker resizes to its own OCR scale anyway.
      const scale = Math.min(
        1,
        PLATE_LIMITS.cropEdge / Math.max(pixelWidth, pixelHeight),
      );
      scaled.width = Math.max(1, Math.round(pixelWidth * scale));
      scaled.height = Math.max(1, Math.round(pixelHeight * scale));
      scaled
        .getContext("2d")!
        .drawImage(
          canvas,
          Math.round(crop.x * sourceWidth),
          Math.round(crop.y * sourceHeight),
          pixelWidth,
          pixelHeight,
          0,
          0,
          scaled.width,
          scaled.height,
        );
      let blob: Blob | null = null;
      for (const quality of [0.8, 0.65, 0.5]) {
        blob = await new Promise<Blob | null>((resolve) =>
          scaled.toBlob(resolve, "image/jpeg", quality),
        );
        if (blob && blob.size <= PLATE_LIMITS.jpegTarget) break;
      }
      if (!blob || blob.size > PLATE_LIMITS.jpegBytes)
        throw new PlateUnavailableError("Plate crop exceeds limit");
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      if (
        !this.plateAvailable ||
        this.socket.readyState !== WebSocket.OPEN ||
        this.platePending.size >= PLATE_LIMITS.maxInFlight
      )
        throw new PlateUnavailableError("Plate recognition unavailable");
      const full: PlateIdentity = {
        ...identity,
        roomId: this.room.roomId,
        requestId: crypto.randomUUID(),
      };
      const packet = encodePlateFrame(
        {
          v: 1,
          type: "camera.plate",
          format: "image/jpeg",
          ...full,
          sourceWidth,
          sourceHeight,
          cropX: crop.x,
          cropY: crop.y,
          cropWidth: crop.width,
          cropHeight: crop.height,
          encodedWidth: scaled.width,
          encodedHeight: scaled.height,
          imageLength: jpeg.length,
        },
        jpeg,
      );
      return await new Promise<PlateResult>((resolve, reject) => {
        const timer = setTimeout(
          () => this.settlePlate(full.requestId, null, "timeout"),
          PLATE_LIMITS.requestTimeoutMs,
        );
        this.platePending.set(full.requestId, {
          identity: full,
          resolve,
          reject,
          timer,
        });
        this.socket!.send(packet.buffer as ArrayBuffer);
        this.lastPlateSentAt = performance.now();
      });
    } finally {
      scaled.width = 1;
      scaled.height = 1;
    }
  }
  private drop(reason: string): GpuDroppedFrameError {
    this.measurements.dropped++;
    this.measurements.backoffMs = Math.min(
      1000,
      Math.max(minimumSendIntervalMs, this.measurements.backoffMs * 1.5),
    );
    this.measurements.intervalMs = Math.max(
      this.measurements.backoffMs,
      Math.min(
        1000,
        Math.max(minimumSendIntervalMs, this.measurements.intervalMs * 1.5),
      ),
    );
    return new GpuDroppedFrameError(reason);
  }
  private waitForOperation<T>(
    promise: Promise<T>,
    operation: FrameOperation,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const signal = operation.controller.signal;
      const canceled = () => {
        signal.removeEventListener("abort", canceled);
        reject(new GpuUnavailableError("GPU analysis canceled"));
      };
      if (signal.aborted) {
        canceled();
      } else signal.addEventListener("abort", canceled, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", canceled);
          if (signal.aborted || this.disposed || !this.operations.has(operation)) {
            canceled();
            return;
          }
          if (
            performance.now() - operation.started >
            GPU_LIMITS.frameTimeoutMs
          ) {
            this.unavailable("GPU analysis timed out");
            canceled();
            return;
          }
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", canceled);
          reject(error);
        },
      );
    });
  }
  private unavailable(reason: string) {
    if (this.disposed) return;
    this.close();
    this.onUnavailable(reason);
  }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.ping = null;
    this.submittedTimes = [];
    this.completedTimes = [];
    for (const operation of this.operations) {
      clearTimeout(operation.timer);
      operation.controller.abort();
      operation.canvas.width = 1;
      operation.canvas.height = 1;
    }
    this.operations.clear();
    this.encoding = false;
    for (const job of this.pending.values())
      job.reject(new GpuUnavailableError("GPU result canceled"));
    this.pending.clear();
    for (const job of this.platePending.values()) {
      clearTimeout(job.timer);
      job.reject(new PlateUnavailableError("Plate result canceled"));
    }
    this.platePending.clear();
    this.plateDescriptor = null;
    if (this.socket) {
      if (this.socket.readyState === WebSocket.OPEN)
        this.socket.send(
          JSON.stringify({
            v: 1,
            type: "camera.cancel",
            roomId: this.room.roomId,
          }),
        );
      this.socket.close();
      this.socket = null;
    }
  }
}
