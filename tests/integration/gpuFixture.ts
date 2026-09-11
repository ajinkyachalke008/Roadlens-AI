import { afterEach, expect, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { createRelay, type RelayConfig } from "../../backend/src/relay.js";
import {
  encodeGpuFrame,
  type GpuFrameHeader,
  type GpuResult,
} from "../../shared/src/gpu.js";
import {
  encodePlateFrame,
  type PlateFrameHeader,
  type PlateResult,
} from "../../shared/src/plates.js";

/**
 * Shared harness for the relay's optional GPU path.
 *
 * Everything here is synthetic: marker JPEGs and hand-written replies exercise
 * transport, correlation and bounds. No test in this harness claims anything
 * about CUDA inference or plate accuracy.
 */
export const origin = "http://127.0.0.1:5173";
export const secret = randomBytes(32).toString("base64url");
export const descriptor = {
  modelId: "synthetic-protocol-fixture",
  modelSha256: "0".repeat(64),
  runtime: "pytorch_cuda" as const,
  inputSize: 640 as const,
};
export const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
export const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(condition: () => boolean, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error("GPU protocol condition timed out");
    await delay();
  }
}
export type Json = Record<string, unknown>;
export class Client {
  socket: WebSocket;
  messages: Json[] = [];
  binaries: Buffer[] = [];
  ended = false;
  constructor(url: string, requestedOrigin?: string) {
    this.socket = new WebSocket(
      url,
      requestedOrigin === undefined ? {} : { origin: requestedOrigin },
    );
    this.socket.on("message", (raw: RawData, binary: boolean) => {
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.from(raw as ArrayBuffer);
      if (binary) this.binaries.push(bytes);
      else this.messages.push(JSON.parse(bytes.toString()));
    });
    this.socket.on("close", () => {
      this.ended = true;
    });
    this.socket.on("error", () => {});
    cleanup.push(() => this.socket.terminate());
  }
  async open() {
    await until(() => this.socket.readyState === WebSocket.OPEN || this.ended);
    return this;
  }
  send(value: unknown) {
    this.socket.send(JSON.stringify(value));
  }
  async message(type: string) {
    await until(() => this.messages.some((message) => message.type === type));
    return this.messages.splice(
      this.messages.findIndex((message) => message.type === type),
      1,
    )[0];
  }
}
// Deliberately synthetic JPEG SOF framing and response metadata; these tests never claim CUDA inference.
export const jpeg = new Uint8Array([
  255, 216, 255, 192, 0, 11, 8, 0, 2, 0, 2, 1, 1, 17, 0, 255, 217,
]);
export const sourceId = randomUUID();
export function frame(roomId: string, seq = 1, previous?: GpuFrameHeader) {
  const captureEpoch = previous?.captureEpoch ?? randomUUID();
  const header: GpuFrameHeader = {
    v: 1,
    type: "camera.frame",
    roomId,
    sourceId,
    captureEpoch,
    frameSeq: seq,
    frameId: `${captureEpoch}:${seq}`,
    sourceTimeMs: seq * 100,
    sourceWidth: 2,
    sourceHeight: 2,
    encodedWidth: 2,
    encodedHeight: 2,
    format: "image/jpeg",
    imageLength: jpeg.length,
  };
  const { imageLength: _length, format: _format, ...fields } = header;
  const result: GpuResult = {
    ...fields,
    type: "inference.result",
    ...descriptor,
    detections: [{ className: "bus", score: 0.8, bbox: [0, 0, 1, 1] }],
    metrics: {
      decodeMs: 1,
      preprocessMs: 1,
      inferenceMs: 2,
      postprocessMs: 1,
      totalMs: 5,
    },
  };
  return { header, result, bytes: encodeGpuFrame(header, jpeg) };
}
export async function fixture(options: Partial<RelayConfig> = {}) {
  let clock = Date.now();
  const relay = createRelay({
    origins: [origin],
    workerSecret: secret,
    now: () => clock,
    ...options,
  });
  await new Promise<void>((resolve) =>
    relay.server.listen(0, "127.0.0.1", resolve),
  );
  cleanup.push(() => relay.close());
  const address = relay.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing relay address");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (
    path: string,
    body?: unknown,
    token?: string,
    method = "POST",
  ) =>
    fetch(base + path, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const connect = (path: string, requestedOrigin?: string) =>
    new Client(base.replace("http:", "ws:") + path, requestedOrigin).open();
  const create = async (connectOwner = true) => {
    const response = await request("/api/rooms", {
      v: 2,
      name: "Protocol test",
    });
    expect(response.status).toBe(201);
    const room = (await response.json()) as {
      roomId: string;
      ownerToken: string;
      pairingCode: string;
    };
    const owner = connectOwner ? await connect("/ws", origin) : null;
    if (owner) {
      owner.send({
        v: 2,
        type: "hello",
        role: "camera",
        roomId: room.roomId,
        token: room.ownerToken,
      });
      await owner.message("hello.ok");
    }
    return { ...room, owner };
  };
  const register = async (plate: PlateDescriptorFixture | null = null) => {
    const worker = await connect("/worker");
    worker.send({
      v: 1,
      type: "worker.register",
      role: "worker",
      secret,
      workerVersion: "1",
    });
    await worker.message("worker.registered");
    worker.send({
      v: 1,
      type: "worker.ready",
      ...descriptor,
      // Omitted unless a test is exercising the plate path, so the default
      // fixture stays exactly what a worker without plate support sends.
      ...(plate ? { plate } : {}),
    });
    await until(() => relay.gpuWss.clients.size > 0);
    await until(() => worker.socket.readyState === WebSocket.OPEN);
    // A same-socket round trip orders worker.ready before the caller's camera handshake.
    worker.send({ v: 1, type: "worker.heartbeat" });
    await worker.message("worker.pong");
    return worker;
  };
  const acquire = async (room: { roomId: string; ownerToken: string }) => {
    const camera = await connect("/gpu", origin);
    camera.send({
      v: 1,
      type: "gpu.hello",
      role: "camera",
      roomId: room.roomId,
      token: room.ownerToken,
    });
    return camera;
  };
  const ready = async (plate: PlateDescriptorFixture | null = null) => {
    const worker = await register(plate);
    const room = await create();
    const camera = await acquire(room);
    expect((await camera.message("gpu.status")).state).toBe("ready");
    return { worker, room, camera };
  };
  return {
    relay,
    base,
    request,
    connect,
    create,
    register,
    acquire,
    ready,
    advance: (ms: number) => {
      clock += ms;
      relay.maintain();
    },
  };
}


export type PlateDescriptorFixture = {
  detectorId: string;
  detectorSha256: string;
  ocrEngine: string;
  inputSize: number;
};
export const plateDescriptor: PlateDescriptorFixture = {
  detectorId: "synthetic-plate-fixture",
  detectorSha256: "1".repeat(64),
  ocrEngine: "synthetic-ocr",
  inputSize: 640,
};
/** A 64 px marker crop: the smallest the protocol will carry. */
export const cropJpeg = new Uint8Array([
  255, 216, 255, 192, 0, 11, 8, 0, 64, 0, 64, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1,
  0, 0, 63, 0, 255, 217,
]);
export function plateRequest(
  roomId: string,
  over: Partial<PlateFrameHeader> = {},
) {
  const captureEpoch = over.captureEpoch ?? randomUUID();
  const frameSeq = over.frameSeq ?? 1;
  const header: PlateFrameHeader = {
    v: 1,
    type: "camera.plate",
    format: "image/jpeg",
    roomId,
    sourceId,
    captureEpoch,
    requestId: randomUUID(),
    frameSeq,
    frameId: `${captureEpoch}:${frameSeq}`,
    trackId: 3,
    sourceTimeMs: frameSeq * 100,
    sourceWidth: 1920,
    sourceHeight: 1080,
    cropX: 0.25,
    cropY: 0.25,
    cropWidth: 0.3,
    cropHeight: 0.3,
    encodedWidth: 64,
    encodedHeight: 64,
    imageLength: cropJpeg.length,
    ...over,
  };
  const {
    imageLength: _length,
    format: _format,
    sourceWidth: _sw,
    sourceHeight: _sh,
    cropX: _cx,
    cropY: _cy,
    cropWidth: _cw,
    cropHeight: _ch,
    encodedWidth: _ew,
    encodedHeight: _eh,
    ...identity
  } = header;
  const result: PlateResult = {
    ...identity,
    type: "plate.result",
    ...plateDescriptor,
    inputSize: plateDescriptor.inputSize,
    plateText: "ABC1234",
    plateConfidence: 0.92,
    detectorConfidence: 0.81,
    plateBox: [0.1, 0.3, 0.7, 0.55],
    metrics: { decodeMs: 1, detectMs: 3, ocrMs: 4, totalMs: 8 },
  };
  return { header, result, bytes: encodePlateFrame(header, cropJpeg) };
}
