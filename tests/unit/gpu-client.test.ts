import { afterEach, expect, it, vi } from "vitest";
import { RemoteDetector } from "../../frontend/src/inference/remote";
import { CameraCapture } from "../../frontend/src/camera/capture";
import { decodeGpuFrame, type GpuIdentity } from "../../shared/src/gpu";
import { epoch, sourceId, uuid } from "../contracts/fixtures";
const jpeg = new Uint8Array([
  255, 216, 255, 192, 0, 11, 8, 1, 104, 2, 128, 1, 1, 17, 0, 255, 218, 0, 8, 1,
  1, 0, 0, 63, 0, 255, 217,
]);
class Socket {
  static OPEN = 1;
  static instance: Socket;
  readyState = 1;
  bufferedAmount = 0;
  sent: (string | ArrayBuffer)[] = [];
  onopen = () => {};
  onclose = () => {};
  onerror = () => {};
  onmessage = (_e: { data: string }) => {};
  constructor() {
    Socket.instance = this;
  }
  send(value: string | ArrayBuffer) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  receive(value: unknown) {
    this.onmessage({ data: JSON.stringify(value) });
  }
}
const descriptor = {
  modelId: "synthetic-protocol-only",
  modelSha256: "a".repeat(64),
  runtime: "pytorch_cuda" as const,
  inputSize: 640 as const,
};
const identity = {
  sourceId,
  captureEpoch: epoch,
  frameSeq: 1,
  frameId: `${epoch}:1`,
  sourceTimeMs: 1500,
  sourceWidth: 1280,
  sourceHeight: 720,
};
async function connected() {
  vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toBlob: (cb: (b: Blob) => void) => cb(new Blob([jpeg])),
    }),
  });
  const client = new RemoteDetector({
    roomId: uuid(1),
    ownerToken: "a".repeat(43),
    pairingCode: "TEST-TEST",
    serverEpoch: uuid(2),
    codeExpiresAt: 0,
    roomExpiresAt: 0,
  });
  const promise = client.connect();
  Socket.instance.onopen();
  Socket.instance.receive({
    v: 1,
    type: "gpu.status",
    state: "ready",
    descriptor,
  });
  await promise;
  return client;
}
const canvas = { width: 1280, height: 720 } as HTMLCanvasElement;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function result(frame: GpuIdentity) {
  return {
    ...frame,
    v: 1,
    type: "inference.result",
    ...descriptor,
    detections: [],
    metrics: {
      decodeMs: 1,
      preprocessMs: 1,
      inferenceMs: 1,
      postprocessMs: 1,
      totalMs: 4,
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("GPU client binds capability in first message only, never URL", async () => {
  const c = await connected();
  expect(JSON.parse(Socket.instance.sent[0] as string)).toMatchObject({
    type: "gpu.hello",
    role: "camera",
    token: "a".repeat(43),
  });
  c.close();
});
it("one active frame and exact source/dimension match; duplicates ignored", async () => {
  const c = await connected();
  const done = c.detect(canvas, identity);
  await tick();
  await expect(c.detect(canvas, { ...identity, frameSeq: 2 })).rejects.toThrow(
    "busy",
  );
  const packet = Socket.instance.sent.find(
    (v) => v instanceof ArrayBuffer,
  ) as ArrayBuffer;
  const { header } = decodeGpuFrame(new Uint8Array(packet));
  const {
    v: _v,
    type: _type,
    format: _format,
    imageLength: _length,
    ...frame
  } = header;
  Socket.instance.receive(result({ ...frame, sourceTimeMs: 1501 }));
  expect(c.diagnostics.completed).toBe(0);
  Socket.instance.receive(result(frame));
  expect((await done).frameId).toBe(identity.frameId);
  Socket.instance.receive(result(frame));
  expect(c.diagnostics.completed).toBe(1);
  expect(c.diagnostics.dropped).toBe(3);
  c.close();
});
it("timeouts reject retained work and explicitly notify fallback", async () => {
  const c = await connected();
  const lost = vi.fn();
  c.onUnavailable = lost;
  vi.useFakeTimers();
  const done = c.detect(canvas, identity).catch((e) => e);
  await vi.advanceTimersByTimeAsync(2100);
  expect(await done).toBeInstanceOf(Error);
  expect(c.ready).toBe(false);
  expect(lost).toHaveBeenCalledOnce();
});
it("changed model descriptor cannot label a retained frame", async () => {
  const c = await connected();
  const done = c.detect(canvas, identity).catch((e) => e);
  await tick();
  const bytes = Socket.instance.sent.find(
    (v) => v instanceof ArrayBuffer,
  ) as ArrayBuffer;
  const {
    v: _v,
    type: _type,
    format: _format,
    imageLength: _length,
    ...frame
  } = decodeGpuFrame(new Uint8Array(bytes)).header;
  Socket.instance.receive({ ...result(frame), modelSha256: "b".repeat(64) });
  expect(await done).toBeInstanceOf(Error);
  expect(c.ready).toBe(false);
  c.close();
});
it("GPU source transition resets epoch/calibration and clears prior analyzed view", async () => {
  const video = { muted: false, playsInline: false } as HTMLVideoElement;
  const capture = new CameraCapture(video);
  const old = capture.captureEpoch;
  const remote = await connected();
  Reflect.set(capture, "running", true); // Synthetic lifecycle state; native transitions are E2E-tested.
  capture.useGpu(remote);
  expect(capture.captureEpoch).not.toBe(old);
  expect(capture.calibration).toBeNull();
  expect(capture.latest).toBeNull();
  const gpuEpoch = capture.captureEpoch;
  Reflect.set(capture, "running", false);
  await capture.useBrowser();
  expect(capture.captureEpoch).not.toBe(gpuEpoch);
  expect(capture.remote).toBeNull();
  expect(capture.background).toBe("background_unverified");
});
