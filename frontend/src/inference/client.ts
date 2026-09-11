import type { DetectionResult, LoadProgress } from "./types";
export class DroppedFrameError extends Error {
  constructor() {
    super("Newer frame replaced pending inference");
    this.name = "DroppedFrameError";
  }
}
interface Job {
  id: number;
  bitmap: ImageBitmap;
  resolve: (value: DetectionResult) => void;
  reject: (reason: Error) => void;
}
export interface DetectorTimeouts {
  loadTimeoutMs?: number;
  inferenceTimeoutMs?: number;
}
export class DetectorClient {
  private worker: Worker | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly loadTimeoutMs: number;
  private readonly inferenceTimeoutMs: number;
  private sequence = 0;
  private active: Job | null = null;
  private pending: Job | null = null;
  private ready = false;
  private disposed = false;
  private loadState: {
    id: number;
    resolve: () => void;
    reject: (reason: Error) => void;
    progress?: (progress: LoadProgress) => void;
  } | null = null;
  constructor(timeouts: DetectorTimeouts = {}) {
    this.loadTimeoutMs = timeouts.loadTimeoutMs ?? 90_000;
    this.inferenceTimeoutMs = timeouts.inferenceTimeoutMs ?? 15_000;
    if (
      !Number.isFinite(this.loadTimeoutMs) ||
      this.loadTimeoutMs <= 0 ||
      this.loadTimeoutMs > 90_000 ||
      !Number.isFinite(this.inferenceTimeoutMs) ||
      this.inferenceTimeoutMs <= 0 ||
      this.inferenceTimeoutMs > 15_000
    )
      throw new Error("Invalid detector timeout limits");
    this.createWorker();
  }
  private clearWatchdog() {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
  private startWatchdog(milliseconds: number, operation: string) {
    this.clearWatchdog();
    // This timer runs outside WASM's worker, so it can terminate a blocked inference.
    this.watchdog = setTimeout(
      () =>
        this.fail(
          new Error(
            `${operation} timed out. Resume to retry, or select the 320 profile.`,
          ),
        ),
      milliseconds,
    );
  }
  private createWorker() {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker = worker;
    worker.onmessage = (event) => {
      if (this.worker !== worker || this.disposed) return;
      const message = event.data;
      const loading = this.loadState;
      if (loading && loading.id === message.id) {
        if (message.type === "progress") {
          loading.progress?.(message.progress);
          return;
        }
        if (message.type === "ready") {
          this.clearWatchdog();
          this.ready = true;
          loading.resolve();
        } else {
          this.fail(new Error(message.message));
          return;
        }
        this.loadState = null;
        return;
      }
      const active = this.active;
      if (active && active.id === message.id) {
        this.clearWatchdog();
        if (message.type === "result") active.resolve(message.result);
        else {
          this.fail(new Error(message.message));
          return;
        }
        this.active = null;
        if (this.pending) {
          const next = this.pending;
          this.pending = null;
          this.start(next);
        }
      }
    };
    worker.onerror = () => {
      if (this.worker !== worker || this.disposed) return;
      this.fail(
        new Error(
          "Detector worker failed. Try the 320 profile or another browser.",
        ),
      );
    };
  }
  load(
    profile: 416 | 320 = 416,
    onProgress?: (progress: LoadProgress) => void,
  ): Promise<void> {
    if (this.disposed || this.active || this.loadState)
      return Promise.reject(new Error("Detector unavailable or busy"));
    this.ready = false;
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.loadState = { id, resolve, reject, progress: onProgress };
      this.startWatchdog(this.loadTimeoutMs, "Detector loading");
      try {
        if (!this.worker) this.createWorker();
        this.worker!.postMessage({
          id,
          type: "load",
          profile,
          base: new URL(import.meta.env.BASE_URL, location.origin).href,
        });
      } catch (error) {
        this.fail(
          error instanceof Error ? error : new Error("Detector loading failed"),
        );
      }
    });
  }
  detect(bitmap: ImageBitmap): Promise<DetectionResult> {
    if (!this.ready || this.disposed) {
      bitmap.close();
      return Promise.reject(new Error("Detector is not loaded"));
    }
    return new Promise((resolve, reject) => {
      const job = { id: ++this.sequence, bitmap, resolve, reject };
      if (this.active) {
        if (this.pending) {
          this.pending.bitmap.close();
          this.pending.reject(new DroppedFrameError());
        }
        this.pending = job;
      } else this.start(job);
    });
  }
  private start(job: Job) {
    this.active = job;
    this.startWatchdog(this.inferenceTimeoutMs, "Analysis");
    try {
      if (!this.worker) throw new Error("Detector worker unavailable");
      if (typeof OffscreenCanvas !== "undefined")
        this.worker.postMessage(
          { id: job.id, type: "detect", bitmap: job.bitmap },
          [job.bitmap],
        );
      else {
        // Older browsers preprocess capture bytes on main thread; neural inference stays in worker.
        const canvas = document.createElement("canvas");
        canvas.width = job.bitmap.width;
        canvas.height = job.bitmap.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas unavailable");
        ctx.drawImage(job.bitmap, 0, 0);
        const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        this.worker.postMessage(
          {
            id: job.id,
            type: "detect",
            width: canvas.width,
            height: canvas.height,
            rgba: rgba.buffer,
          },
          [rgba.buffer],
        );
        canvas.width = 1;
        canvas.height = 1;
        job.bitmap.close();
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Capture failed"));
    }
  }
  private fail(error: Error) {
    this.clearWatchdog();
    this.ready = false;
    this.loadState?.reject(error);
    this.loadState = null;
    this.active?.bitmap.close();
    this.active?.reject(error);
    this.active = null;
    if (this.pending) {
      this.pending.bitmap.close();
      this.pending.reject(error);
      this.pending = null;
    }
    this.worker?.terminate();
    this.worker = null;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(new Error("Detector disposed"));
  }
}
