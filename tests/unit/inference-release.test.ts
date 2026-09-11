import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DetectorClient } from "../../frontend/src/inference/client";
import { validateManifest } from "../../frontend/src/inference/manifest";
import { letterbox } from "../../frontend/src/inference/preprocess";
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: Record<string, unknown> }) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  reply(type: string, id: number, extra: Record<string, unknown> = {}) {
    this.onmessage?.({ data: { type, id, ...extra } });
  }
  get id() {
    return this.postMessage.mock.calls.at(-1)![0].id as number;
  }
}
function bitmap() {
  return { width: 640, height: 360, close: vi.fn() } as unknown as ImageBitmap;
}
beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("B41/B42 model deadlines use the main thread, not a possibly blocked inference worker", () => {
  it("bounds loading despite progress and permits a fresh-worker retry after timeout", async () => {
    const client = new DetectorClient({
      loadTimeoutMs: 30,
      inferenceTimeoutMs: 10,
    });
    const loading = client.load().catch((error) => error);
    const old = FakeWorker.instances[0]!;
    await vi.advanceTimersByTimeAsync(20);
    old.reply("progress", old.id, {
      progress: { loaded: 1, total: 10, stage: "download" },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(String(await loading)).toContain("loading timed out");
    expect(old.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const retry = client.load(320);
    const fresh = FakeWorker.instances[1]!;
    old.reply("ready", fresh.id);
    expect(vi.getTimerCount()).toBe(1);
    fresh.reply("ready", fresh.id);
    await retry;
    expect(vi.getTimerCount()).toBe(0);
    client.dispose();
  });
  it("terminates a stalled active inference, rejects pending work, and closes both frame handles", async () => {
    const client = new DetectorClient({
      loadTimeoutMs: 30,
      inferenceTimeoutMs: 10,
    });
    const ready = client.load();
    const worker = FakeWorker.instances[0]!;
    worker.reply("ready", worker.id);
    await ready;
    const a = bitmap(),
      b = bitmap();
    const active = client.detect(a).catch((error) => error),
      pending = client.detect(b).catch((error) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(String(await active)).toContain("Analysis timed out");
    expect(String(await pending)).toContain("Analysis timed out");
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const retry = client.load();
    const fresh = FakeWorker.instances[1]!;
    fresh.reply("ready", fresh.id);
    await retry;
    client.dispose();
  });
  it("clears deadlines on success and permanently rejects use after disposal", async () => {
    const client = new DetectorClient({
      loadTimeoutMs: 30,
      inferenceTimeoutMs: 10,
    });
    const ready = client.load();
    const worker = FakeWorker.instances[0]!;
    worker.reply("ready", worker.id);
    await ready;
    const job = client.detect(bitmap());
    worker.reply("result", worker.id, { result: { detections: [] } });
    expect(await job).toEqual({ detections: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    client.dispose();
    await expect(client.load()).rejects.toThrow("unavailable");
  });
  it("handles postMessage failures without an active-job or timer leak", async () => {
    const client = new DetectorClient();
    const ready = client.load();
    const worker = FakeWorker.instances[0]!;
    worker.reply("ready", worker.id);
    await ready;
    worker.postMessage.mockImplementation(() => {
      throw new Error("transfer failed");
    });
    const image = bitmap();
    await expect(client.detect(image)).rejects.toThrow("transfer failed");
    expect(image.close).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    client.dispose();
  });
  it("does not permit invalid or unbounded injected timeout settings", () => {
    expect(() => new DetectorClient({ loadTimeoutMs: Infinity })).toThrow(
      "timeout",
    );
    expect(() => new DetectorClient({ inferenceTimeoutMs: 15001 })).toThrow(
      "timeout",
    );
    expect(() => new DetectorClient({ loadTimeoutMs: 0 })).toThrow("timeout");
  });
});
describe("B02/B04 declared model preprocessing must match implemented behavior", () => {
  const baseline = JSON.parse(
    readFileSync("frontend/public/models/yolo26n-416.json", "utf8"),
  );
  it("rejects unknown decoder versions and unsupported resize/padding/rounding policies", () => {
    expect(validateManifest(baseline).id).toBe(baseline.id);
    expect(() =>
      validateManifest({ ...baseline, decoderVersion: "unimplemented-v99" }),
    ).toThrow("decoder");
    for (const change of [
      { padding: 0 },
      { resize: "nearest" },
      { rounding: "floor" },
      { extraPadding: "top_left" },
    ])
      expect(() =>
        validateManifest({
          ...baseline,
          letterbox: { ...baseline.letterbox, ...change },
        }),
      ).toThrow("preprocessing");
    expect(() =>
      validateManifest({ ...baseline, letterbox: undefined }),
    ).toThrow("preprocessing");
  });
  it("rejects incompatible output axes and reversed confidence thresholds before inference", () => {
    expect(() =>
      validateManifest({
        ...baseline,
        output: { ...baseline.output, shape: [1, 6, 300] },
      }),
    ).toThrow("shape");
    expect(() =>
      validateManifest({
        ...baseline,
        confidence: { low: 0.7, high: 0.5, newTrack: 0.6 },
      }),
    ).toThrow("ordering");
  });
  it("rejects extreme aspect ratios that would yield zero resize scale", () => {
    expect(() => letterbox(1, 10000, 416)).toThrow("aspect");
    expect(() => letterbox(10000, 1, 320)).toThrow("aspect");
    expect(letterbox(1080, 1920, 416).scaleX).toBeGreaterThan(0);
  });
});
