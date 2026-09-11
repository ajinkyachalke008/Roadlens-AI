import { GPU_LIMITS } from "../../../shared/src/limits";
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
}
export class GpuUnavailableError extends Error {}
/** Transient congestion drops this frame without invalidating the GPU connection. */
export class GpuDroppedFrameError extends Error {}
const minimumSendIntervalMs = 1000 / GPU_LIMITS.maxHz + 5;
interface FrameOperation {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  canvas: HTMLCanvasElement;
  started: number;
}

/** One outstanding frame. CameraCapture retains its exact canvas until this promise completes. */
export class RemoteDetector {
  descriptor: GpuDescriptor | null = null;
  ready = false;
  private measurements: Omit<GpuDiagnostics, "submittedHz" | "resultHz"> = {
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
    };
  }
  onUnavailable = (_reason: string) => {};
  private socket: WebSocket | null = null;
  private disposed = false;
  private encoding = false;
  // Connection-wide: source/seek epochs must not reset the relay's rate ceiling.
  private lastSuccessfulSendAt = -Infinity;
  private operation: FrameOperation | null = null;
  private pending: {
    identity: GpuIdentity;
    resolve: (value: GpuResult) => void;
    reject: (error: Error) => void;
    started: number;
  } | null = null;
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
          } else if (m.type === "inference.error") {
            if (
              m.roomId === this.pending?.identity.roomId &&
              m.frameId === this.pending.identity.frameId
            ) {
              if (m.code === "busy") {
                const job = this.pending;
                this.pending = null;
                job.reject(this.drop("GPU worker busy; frame dropped"));
              } else this.unavailable("GPU analysis unavailable");
            }
          } else {
            const job = this.pending;
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
            this.pending = null;
            this.measurements.completed++;
            this.completedTimes.push(performance.now());
            this.completedTimes = this.completedTimes.slice(-80);
            this.measurements.resultAgeMs = age;
            this.measurements.worker = m.metrics;
            // One active job is the primary backpressure. Smooth the measured service cycle.
            const desired = Math.max(
              minimumSendIntervalMs,
              Math.min(1000, age * 1.15),
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
    if (this.pending || this.encoding)
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
      // Covers JPEG encoding, Blob reads and the network/GPU round trip together.
      timer: setTimeout(
        () => this.unavailable("GPU analysis timed out"),
        GPU_LIMITS.frameTimeoutMs,
      ),
    };
    this.operation = operation;
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
        GPU_LIMITS.messageBytes
      )
        throw this.drop("GPU network is congested; frame dropped");
      if (performance.now() - this.lastSuccessfulSendAt < minimumSendIntervalMs)
        throw this.drop("GPU send rate limited; frame dropped");
      this.measurements.encodeMs = performance.now() - started;
      return await this.waitForOperation(
        new Promise<GpuResult>((resolve, reject) => {
          this.pending = { identity: frame, resolve, reject, started };
          this.socket!.send(packet.buffer as ArrayBuffer);
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
      if (this.operation === operation) {
        this.operation = null;
        this.pending = null;
      }
      this.encoding = false;
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
          if (signal.aborted || this.disposed || this.operation !== operation) {
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
    if (this.operation) {
      clearTimeout(this.operation.timer);
      this.operation.controller.abort();
      this.operation.canvas.width = 1;
      this.operation.canvas.height = 1;
      this.operation = null;
    }
    this.encoding = false;
    if (this.pending) {
      this.pending.reject(new GpuUnavailableError("GPU result canceled"));
      this.pending = null;
    }
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
