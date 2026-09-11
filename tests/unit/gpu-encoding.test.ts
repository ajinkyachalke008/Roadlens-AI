import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GpuDroppedFrameError,
  RemoteDetector,
} from "../../frontend/src/inference/remote";
import { GPU_LIMITS } from "../../shared/src/limits";
import { decodeGpuFrame } from "../../shared/src/gpu";
import { epoch, sourceId, uuid } from "../contracts/fixtures";
// Minimal schema-valid JPEG bytes test transport control only; no inference is mocked as proof.
const jpeg = new Uint8Array([
  255, 216, 255, 192, 0, 11, 8, 1, 104, 2, 128, 1, 1, 17, 0, 255, 218, 0, 8, 1,
  1, 0, 0, 63, 0, 255, 217,
]);
const descriptor = {
  modelId: "synthetic-encoding-control",
  modelSha256: "a".repeat(64),
  runtime: "pytorch_cuda" as const,
  inputSize: 640 as const,
};
const identity = {
  sourceId,
  captureEpoch: epoch,
  frameSeq: 1,
  frameId: `${epoch}:1`,
  sourceTimeMs: 500,
  sourceWidth: 1280,
  sourceHeight: 720,
};
const source = { width: 1280, height: 720 } as HTMLCanvasElement;
class Socket {
  static OPEN = 1;
  static instance: Socket;
  readyState = 1;
  bufferedAmount = 0;
  sent: (string | ArrayBuffer)[] = [];
  onopen = () => {};
  onclose = () => {};
  onerror = () => {};
  onmessage = (_event: { data: string }) => {};
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
let encode: (callback: (blob: Blob | null) => void) => void;
let scaled: { width: number; height: number }[];
let clients: RemoteDetector[];
beforeEach(() => {
  vi.useFakeTimers();
  scaled = [];
  clients = [];
  encode = (cb) => cb(new Blob([jpeg]));
  vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("document", {
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (cb: (blob: Blob | null) => void) => encode(cb),
      };
      scaled.push(canvas);
      return canvas;
    },
  });
});
afterEach(() => {
  for (const client of clients) client.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function ready() {
  const client = new RemoteDetector({
    roomId: uuid(1),
    ownerToken: "a".repeat(43),
    pairingCode: "TEST-TEST",
    serverEpoch: uuid(2),
    codeExpiresAt: 0,
    roomExpiresAt: 0,
  });
  clients.push(client);
  const connected = client.connect();
  Socket.instance.onopen();
  Socket.instance.receive({
    v: 1,
    type: "gpu.status",
    state: "ready",
    descriptor,
  });
  await connected;
  return client;
}
const binary = () =>
  Socket.instance.sent.filter((x) => x instanceof ArrayBuffer) as ArrayBuffer[];
function completeFrame(frameId: string) {
  const packet = binary()
    .map((bytes) => decodeGpuFrame(new Uint8Array(bytes)).header)
    .find((header) => header.frameId === frameId);
  if (!packet) throw new Error(`no submitted frame ${frameId}`);
  const {
    v: _v,
    type: _type,
    format: _format,
    imageLength: _length,
    ...frame
  } = packet;
  Socket.instance.receive({
    v: 1,
    type: "inference.result",
    ...frame,
    ...descriptor,
    detections: [],
    metrics: {
      decodeMs: 1,
      preprocessMs: 1,
      inferenceMs: 1,
      postprocessMs: 1,
      totalMs: 4,
    },
  });
}
function complete() {
  const { header } = decodeGpuFrame(new Uint8Array(binary().at(-1)!));
  const {
    v: _v,
    type: _type,
    format: _format,
    imageLength: _length,
    ...frame
  } = header;
  Socket.instance.receive({
    v: 1,
    type: "inference.result",
    ...frame,
    ...descriptor,
    detections: [],
    metrics: {
      decodeMs: 1,
      preprocessMs: 1,
      inferenceMs: 1,
      postprocessMs: 1,
      totalMs: 4,
    },
  });
}
it("close cancels a stalled JPEG encoder immediately and fences its late callback", async () => {
  const client = await ready();
  let finish!: (blob: Blob | null) => void;
  encode = (cb) => {
    finish = cb;
  };
  const result = client.detect(source, identity).catch((e) => e);
  expect(scaled[0]!.width).toBe(640);
  client.close();
  expect(scaled[0]).toMatchObject({ width: 1, height: 1 });
  expect(await result).toBeInstanceOf(Error);
  finish(new Blob([jpeg]));
  await vi.advanceTimersByTimeAsync(0);
  expect(binary()).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("total deadline includes an encoder that never invokes its callback", async () => {
  const client = await ready();
  const lost = vi.fn();
  client.onUnavailable = lost;
  encode = () => {};
  const result = client.detect(source, identity).catch((e) => e);
  await vi.advanceTimersByTimeAsync(GPU_LIMITS.frameTimeoutMs);
  expect(await result).toBeInstanceOf(Error);
  expect(lost).toHaveBeenCalledOnce();
  expect(client.ready).toBe(false);
  expect(scaled[0]).toMatchObject({ width: 1, height: 1 });
  expect(binary()).toHaveLength(0);
});
it("close also cancels a stalled Blob arrayBuffer read", async () => {
  const client = await ready();
  let release!: (bytes: ArrayBuffer) => void;
  encode = (cb) =>
    cb({
      size: jpeg.length,
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          release = resolve;
        }),
    } as Blob);
  const result = client.detect(source, identity).catch((e) => e);
  await vi.advanceTimersByTimeAsync(0);
  client.close();
  expect(await result).toBeInstanceOf(Error);
  release(jpeg.slice().buffer);
  await vi.advanceTimersByTimeAsync(0);
  expect(binary()).toHaveLength(0);
  expect(scaled[0]).toMatchObject({ width: 1, height: 1 });
});
it("network waiting receives only the remaining deadline after encoding", async () => {
  const client = await ready();
  let finish!: (blob: Blob | null) => void;
  encode = (cb) => {
    finish = cb;
  };
  const result = client.detect(source, identity).catch((e) => e);
  await vi.advanceTimersByTimeAsync(1500);
  finish(new Blob([jpeg]));
  await vi.advanceTimersByTimeAsync(0);
  expect(binary()).toHaveLength(1);
  expect(client.ready).toBe(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toBeInstanceOf(Error);
  expect(client.ready).toBe(false);
});
it("keeps one operation while encoding and does not allocate another canvas", async () => {
  const client = await ready();
  encode = () => {};
  const first = client.detect(source, identity).catch((e) => e);
  await expect(client.detect(source, identity)).rejects.toThrow("busy");
  expect(scaled).toHaveLength(1);
  client.close();
  expect(await first).toBeInstanceOf(Error);
});
it("admits exactly maxInFlight frames and drops the frame beyond the bound", async () => {
  const client = await ready();
  expect(client.maxInFlight).toBe(GPU_LIMITS.maxInFlight);
  const started: Promise<unknown>[] = [];
  for (let i = 0; i < client.maxInFlight; i++) {
    // Submissions are additionally spaced by the protocol send-rate floor.
    await vi.advanceTimersByTimeAsync(1000 / GPU_LIMITS.maxHz + 6);
    started.push(
      client
        .detect(source, { ...identity, frameSeq: i, frameId: `${epoch}:${i}` })
        .catch((e) => e),
    );
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(binary()).toHaveLength(client.maxInFlight);
  expect(client.diagnostics.inFlight).toBe(client.maxInFlight);
  // The frame past the bound is dropped, never queued.
  await vi.advanceTimersByTimeAsync(1000 / GPU_LIMITS.maxHz + 6);
  await expect(
    client.detect(source, {
      ...identity,
      frameSeq: client.maxInFlight,
      frameId: `${epoch}:${client.maxInFlight}`,
    }),
  ).rejects.toBeInstanceOf(GpuDroppedFrameError);
  expect(binary()).toHaveLength(client.maxInFlight);
  expect(client.diagnostics.inFlight).toBe(client.maxInFlight);
  client.close();
  for (const promise of started) expect(await promise).toBeInstanceOf(Error);
  expect(client.diagnostics.inFlight).toBe(0);
});
it("backpressure rejects before send, releases encoding state, and permits later useful work", async () => {
  const client = await ready();
  // The socket buffer may legitimately hold one packet per in-flight frame.
  Socket.instance.bufferedAmount = GPU_LIMITS.messageBytes * client.maxInFlight;
  await expect(client.detect(source, identity)).rejects.toBeInstanceOf(
    GpuDroppedFrameError,
  );
  expect(client.ready).toBe(true);
  expect(client.diagnostics.dropped).toBe(1);
  expect(binary()).toHaveLength(0);
  expect(scaled[0]).toMatchObject({ width: 1, height: 1 });
  Socket.instance.bufferedAmount = 0;
  const result = client.detect(source, identity);
  await vi.advanceTimersByTimeAsync(0);
  complete();
  expect((await result).frameId).toBe(identity.frameId);
  await vi.advanceTimersByTimeAsync(2500);
  expect(client.ready).toBe(true);
  expect(client.diagnostics.completed).toBe(1);
});
it("worker busy drops its active frame, retains readiness, and recovers without fallback", async () => {
  const client = await ready();
  const lost = vi.fn();
  client.onUnavailable = lost;
  const first = client.detect(source, identity).catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  Socket.instance.receive({
    v: 1,
    type: "inference.error",
    roomId: uuid(1),
    frameId: identity.frameId,
    code: "busy",
  });
  expect(await first).toBeInstanceOf(GpuDroppedFrameError);
  expect(client.ready).toBe(true);
  expect(Socket.instance.readyState).toBe(Socket.OPEN);
  expect(lost).not.toHaveBeenCalled();
  expect(client.diagnostics.dropped).toBe(1);
  expect(client.diagnostics.intervalMs).toBeGreaterThan(100);
  expect(scaled[0]).toMatchObject({ width: 1, height: 1 });
  await vi.advanceTimersByTimeAsync(client.diagnostics.intervalMs);
  const next = client.detect(source, {
    ...identity,
    frameSeq: 2,
    frameId: `${epoch}:2`,
  });
  await vi.advanceTimersByTimeAsync(0);
  complete();
  expect((await next).frameSeq).toBe(2);
  expect(client.diagnostics.completed).toBe(1);
  expect(lost).not.toHaveBeenCalled();
});
it("successful send spacing survives source epoch resets and drops before encoding", async () => {
  const client = await ready();
  const first = client.detect(source, identity);
  await vi.advanceTimersByTimeAsync(0);
  complete();
  await first;
  await vi.advanceTimersByTimeAsync(20);
  const changed = {
    ...identity,
    captureEpoch: uuid(33),
    frameSeq: 0,
    frameId: `${uuid(33)}:0`,
    sourceTimeMs: 0,
  };
  await expect(client.detect(source, changed)).rejects.toBeInstanceOf(
    GpuDroppedFrameError,
  );
  expect(scaled).toHaveLength(1);
  expect(binary()).toHaveLength(1);
  expect(client.ready).toBe(true);
  await vi.advanceTimersByTimeAsync(1000 / GPU_LIMITS.maxHz + 6 - 20);
  const next = client.detect(source, changed);
  await vi.advanceTimersByTimeAsync(0);
  complete();
  expect((await next).captureEpoch).toBe(changed.captureEpoch);
  expect(binary()).toHaveLength(2);
  expect(client.diagnostics.submittedHz).toBeLessThan(GPU_LIMITS.maxHz);
});
it("encoder rejection releases deadline and canvas without retaining pending work", async () => {
  const client = await ready();
  encode = (cb) =>
    cb({
      size: jpeg.length,
      arrayBuffer: () => Promise.reject(new Error("encoded bytes unavailable")),
    } as Blob);
  await expect(client.detect(source, identity)).rejects.toThrow(
    "encoded bytes unavailable",
  );
  expect(scaled[0]).toMatchObject({ width: 1, height: 1 });
  expect(binary()).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(1);
});
it("reports actual recent submission/result rates and expires inactive samples", async () => {
  const client = await ready();
  for (let seq = 1; seq <= 2; seq++) {
    const promise = client.detect(source, {
      ...identity,
      frameSeq: seq,
      frameId: `${epoch}:${seq}`,
    });
    await vi.advanceTimersByTimeAsync(0);
    complete();
    await promise;
    if (seq === 1) await vi.advanceTimersByTimeAsync(100);
  }
  expect(client.diagnostics.submittedHz).toBeCloseTo(10);
  expect(client.diagnostics.resultHz).toBeCloseTo(10);
  await vi.advanceTimersByTimeAsync(5001);
  expect(client.diagnostics.submittedHz).toBe(0);
  expect(client.diagnostics.resultHz).toBe(0);
});
it("falls back to one frame in flight against a relay that only admits one", async () => {
  const client = await ready();
  expect(client.maxInFlight).toBe(GPU_LIMITS.maxInFlight);
  const refuseSecondFrame = async (seq: number) => {
    // First frame is admitted and stays outstanding.
    await vi.advanceTimersByTimeAsync(1000 / GPU_LIMITS.maxHz + 6);
    const first = client
      .detect(source, { ...identity, frameSeq: seq, frameId: `${epoch}:${seq}` })
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    // Second frame is admitted locally, then refused by the older relay.
    await vi.advanceTimersByTimeAsync(1000 / GPU_LIMITS.maxHz + 6);
    const second = client
      .detect(source, {
        ...identity,
        frameSeq: seq + 1,
        frameId: `${epoch}:${seq + 1}`,
      })
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    Socket.instance.receive({
      v: 1,
      type: "inference.error",
      roomId: uuid(1),
      frameId: `${epoch}:${seq + 1}`,
      code: "busy",
    });
    expect(await second).toBeInstanceOf(GpuDroppedFrameError);
    // Resolve the frame the relay actually accepted, not the refused one.
    completeFrame(`${epoch}:${seq}`);
    await first;
  };
  // An isolated refusal is a race, not evidence: depth is retained.
  await refuseSecondFrame(10);
  expect(client.maxInFlight).toBe(GPU_LIMITS.maxInFlight);
  await refuseSecondFrame(20);
  expect(client.maxInFlight).toBe(GPU_LIMITS.maxInFlight);
  // Systematic refusal is evidence: the client settles at one frame in flight.
  await refuseSecondFrame(30);
  expect(client.maxInFlight).toBe(1);
  // The connection stays healthy and keeps analysing; it does not fall back to
  // the browser detector, and the downgrade is permanent for this connection.
  expect(client.ready).toBe(true);
  await vi.advanceTimersByTimeAsync(1000 / GPU_LIMITS.maxHz + 6);
  const next = client.detect(source, {
    ...identity,
    frameSeq: 40,
    frameId: `${epoch}:40`,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(client.diagnostics.inFlight).toBe(1);
  await vi.advanceTimersByTimeAsync(1000 / GPU_LIMITS.maxHz + 6);
  await expect(
    client.detect(source, {
      ...identity,
      frameSeq: 41,
      frameId: `${epoch}:41`,
    }),
  ).rejects.toBeInstanceOf(GpuDroppedFrameError);
  completeFrame(`${epoch}:40`);
  expect((await next).frameId).toBe(`${epoch}:40`);
  expect(client.maxInFlight).toBe(1);
});
