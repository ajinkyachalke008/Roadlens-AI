import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { GPU_LIMITS } from "../../shared/src/limits.js";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket, type RawData } from "ws";
import { createRelay, type RelayConfig } from "../../backend/src/relay.js";
import * as gpuProtocol from "../../shared/src/gpu.js";
import {
  decodeGpuFrame,
  encodeGpuFrame,
  type GpuFrameHeader,
  type GpuResult,
} from "../../shared/src/gpu.js";

const origin = "http://127.0.0.1:5173";
const secret = randomBytes(32).toString("base64url");
const descriptor = {
  modelId: "synthetic-protocol-fixture",
  modelSha256: "0".repeat(64),
  runtime: "pytorch_cuda" as const,
  inputSize: 640 as const,
};
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error("GPU protocol condition timed out");
    await delay();
  }
}
type Json = Record<string, unknown>;
class Client {
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
const jpeg = new Uint8Array([
  255, 216, 255, 192, 0, 11, 8, 0, 2, 0, 2, 1, 1, 17, 0, 255, 217,
]);
const sourceId = randomUUID();
function frame(roomId: string, seq = 1, previous?: GpuFrameHeader) {
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
async function fixture(options: Partial<RelayConfig> = {}) {
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
  const register = async () => {
    const worker = await connect("/worker");
    worker.send({
      v: 1,
      type: "worker.register",
      role: "worker",
      secret,
      workerVersion: "1",
    });
    await worker.message("worker.registered");
    worker.send({ v: 1, type: "worker.ready", ...descriptor });
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
  const ready = async () => {
    const worker = await register();
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

describe("Optional GPU relay: real transport with explicit synthetic inference replies", () => {
  it("is disabled without a machine secret and exposes no machine descriptor publicly", async () => {
    const f = await fixture({ workerSecret: undefined });
    expect(
      (
        await (
          await f.request("/api/config", undefined, undefined, "GET")
        ).json()
      ).gpu,
    ).toEqual({ enabled: false, state: "offline" });
    const client = await f.connect("/worker");
    await until(() => client.ended);
    expect(f.relay.stats().gpu.sockets).toBe(0);
    expect(() =>
      createRelay({ origins: [origin], workerSecret: "short" }),
    ).toThrow("32-byte");
  });
  it("requires machine-only Origin rules, correct secret and role-bound registration", async () => {
    const f = await fixture();
    for (const value of [origin, "https://evil.example"]) {
      const browser = await f.connect("/worker", value);
      await until(() => browser.ended);
    }
    const wrong = await f.connect("/worker");
    wrong.send({
      v: 1,
      type: "worker.register",
      role: "worker",
      secret: "x".repeat(43),
      workerVersion: "1",
    });
    await until(() => wrong.ended);
    const wrongRole = await f.connect("/worker");
    wrongRole.send({
      v: 1,
      type: "gpu.hello",
      role: "camera",
      roomId: randomUUID(),
      token: secret,
    });
    await until(() => wrongRole.ended);
    const missing = await f.connect("/gpu");
    await until(() => missing.ended);
    const evil = await f.connect("/gpu", "https://evil.example");
    await until(() => evil.ended);
    const query = await f.connect("/worker?secret=not-a-real-secret");
    await until(() => query.ended);
    expect((await f.register()).ended).toBe(false);
  });
  it("requires the live owner control connection and rejects viewer/cross-room capabilities", async () => {
    const f = await fixture();
    await f.register();
    const a = await f.create(false);
    const premature = await f.acquire(a);
    await until(() => premature.ended);
    const b = await f.create();
    const joined = await (
      await f.request("/api/join", { v: 2, code: b.pairingCode })
    ).json();
    const viewer = await f.acquire({
      roomId: b.roomId,
      ownerToken: joined.viewerToken,
    });
    await until(() => viewer.ended);
    const cross = await f.acquire({
      roomId: b.roomId,
      ownerToken: a.ownerToken,
    });
    await until(() => cross.ended);
    const valid = await f.acquire(b);
    expect((await valid.message("gpu.status")).state).toBe("ready");
  });
  it("admits only one worker and one leased camera, with no waiting queue", async () => {
    const f = await fixture();
    const { worker, room } = await f.ready();
    const secondWorker = await f.connect("/worker");
    secondWorker.send({
      v: 1,
      type: "worker.register",
      role: "worker",
      secret,
      workerVersion: "1",
    });
    await until(() => secondWorker.ended);
    const sameRoom = await f.acquire(room);
    expect((await sameRoom.message("gpu.status")).state).toBe("busy");
    const other = await f.acquire(await f.create());
    expect((await other.message("gpu.status")).state).toBe("busy");
    expect(worker.ended).toBe(false);
    expect(f.relay.stats().gpu.pending).toBe(0);
    expect(
      (
        await (
          await f.request("/api/config", undefined, undefined, "GET")
        ).json()
      ).gpu,
    ).toEqual({ enabled: true, state: "busy" });
  });
  it("forwards an atomic frame to the worker and the exact result only to its camera", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready();
    const joined = await (
      await f.request("/api/join", { v: 2, code: room.pairingCode })
    ).json();
    const viewer = await f.connect("/ws", origin);
    viewer.send({
      v: 2,
      type: "hello",
      role: "viewer",
      roomId: room.roomId,
      token: joined.viewerToken,
    });
    await viewer.message("hello.ok");
    const sample = frame(room.roomId);
    const before = f.relay.stats().bootBytes;
    camera.socket.send(sample.bytes);
    await until(() => worker.binaries.length === 1);
    expect(decodeGpuFrame(worker.binaries[0]).header).toEqual(sample.header);
    expect(f.relay.stats().bootBytes - before).toBe(sample.bytes.length);
    worker.send(sample.result);
    expect(await camera.message("inference.result")).toEqual(sample.result);
    expect(f.relay.stats().bootBytes - before).toBe(
      sample.bytes.length + Buffer.byteLength(JSON.stringify(sample.result)),
    );
    expect(viewer.binaries).toHaveLength(0);
    expect(
      viewer.messages.some((value) => value.type === "inference.result"),
    ).toBe(false);
    expect(f.relay.stats().gpu.pending).toBe(0);
  });
  it.each(["room", "epoch", "time", "dimensions", "model", "classes"])(
    "rejects a %s-mismatched worker result without changing owner authority",
    async (field) => {
      const f = await fixture();
      const { worker, room, camera } = await f.ready();
      const sample = frame(room.roomId);
      camera.socket.send(sample.bytes);
      await until(() => worker.binaries.length === 1);
      const result: Record<string, unknown> = { ...sample.result };
      if (field === "room") result.roomId = randomUUID();
      if (field === "epoch") {
        result.captureEpoch = randomUUID();
        result.frameId = `${result.captureEpoch}:1`;
      }
      if (field === "time") result.sourceTimeMs = 999;
      if (field === "dimensions") {
        result.encodedWidth = 1;
        result.encodedHeight = 1;
      }
      if (field === "model") result.modelSha256 = "1".repeat(64);
      if (field === "classes")
        result.detections = [
          { className: "airplane", score: 0.9, bbox: [0, 0, 1, 1] },
        ];
      worker.send(result);
      await until(() => worker.ended);
      expect(
        camera.messages.some((message) => message.type === "inference.result"),
      ).toBe(false);
      room.owner!.send({ v: 2, type: "ping" });
      await room.owner!.message("pong");
    },
  );
  it("bounds in-flight work, rejects duplicate/source-time regressions and rate excess", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready();
    const first = frame(room.roomId);
    camera.socket.send(first.bytes);
    await until(() => worker.binaries.length === 1);
    camera.socket.send(frame(room.roomId, 2, first.header).bytes);
    expect((await camera.message("inference.error")).code).toBe("busy");
    expect(worker.binaries).toHaveLength(1);
    worker.send(first.result);
    await camera.message("inference.result");
    camera.socket.send(frame(room.roomId, 2, first.header).bytes);
    await camera.message("inference.error");
    f.advance(100);
    camera.socket.send(first.bytes);
    await camera.message("inference.error");
    const next = frame(room.roomId, 2, first.header);
    camera.socket.send(next.bytes);
    await until(() => worker.binaries.length === 2);
    worker.send(next.result);
    await camera.message("inference.result");
    expect(f.relay.stats().gpu.pending).toBe(0);
  });
  it("admits exactly maxInFlight identities and completes them out of order", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready();
    const first = frame(room.roomId);
    camera.socket.send(first.bytes);
    await until(() => worker.binaries.length === 1);
    // Past the submission-rate floor the relay admits the second frame.
    const second = frame(room.roomId, 2, first.header);
    f.advance(100);
    camera.socket.send(second.bytes);
    await until(() => worker.binaries.length === 2);
    expect(f.relay.stats().gpu.pending).toBe(GPU_LIMITS.maxInFlight);
    // A third identity exceeds the bound and is refused rather than queued.
    f.advance(100);
    camera.socket.send(frame(room.roomId, 3, first.header).bytes);
    expect((await camera.message("inference.error")).code).toBe("busy");
    expect(worker.binaries).toHaveLength(2);
    expect(f.relay.stats().gpu.pending).toBe(GPU_LIMITS.maxInFlight);
    // Correlation is by exact identity, so a newer completion may land first.
    worker.send(second.result);
    expect((await camera.message("inference.result")).frameId).toBe(
      second.header.frameId,
    );
    expect(f.relay.stats().gpu.pending).toBe(1);
    worker.send(first.result);
    expect((await camera.message("inference.result")).frameId).toBe(
      first.header.frameId,
    );
    expect(f.relay.stats().gpu.pending).toBe(0);
    room.owner!.send({ v: 2, type: "ping" });
    await room.owner!.message("pong");
  });
  it("closes a valid binary flood on message 21 before decoding it", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready();
    // Call-through observation only: all real envelope validation still executes.
    const decode = vi.spyOn(gpuProtocol, "decodeGpuFrame");
    const first = frame(room.roomId);
    for (let seq = 1; seq <= 21; seq++) {
      camera.socket.send(frame(room.roomId, seq, first.header).bytes);
    }
    await until(() => camera.ended);
    expect(decode).toHaveBeenCalledTimes(20);
    expect(worker.binaries).toHaveLength(1);
    expect(
      camera.messages.filter(
        (message) =>
          message.type === "inference.error" && message.code === "busy",
      ),
    ).toHaveLength(19);
    expect(f.relay.stats().gpu).toMatchObject({
      leased: false,
      pending: 1,
      retired: 1,
    });
    expect(worker.ended).toBe(false);
    room.owner!.send({ v: 2, type: "ping" });
    await room.owner!.message("pong");
  });
  it("retains only one canceled identity until its late result drains; no next lease queues behind it", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready();
    const sample = frame(room.roomId);
    camera.socket.send(sample.bytes);
    await until(() => worker.binaries.length === 1);
    camera.send({ v: 1, type: "camera.cancel", roomId: room.roomId });
    await worker.message("camera.cancel");
    await until(() => camera.ended);
    expect(f.relay.stats().gpu).toMatchObject({
      leased: false,
      pending: 1,
      retired: 1,
    });
    const waiting = await f.acquire(room);
    expect((await waiting.message("gpu.status")).state).toBe("busy");
    worker.send(sample.result);
    await until(() => f.relay.stats().gpu.pending === 0);
    expect(worker.ended).toBe(false);
    const resumed = await f.acquire(room);
    expect((await resumed.message("gpu.status")).state).toBe("ready");
    expect(
      resumed.messages.some((message) => message.type === "inference.result"),
    ).toBe(false);
  });
  it("a two-second deadline clears work and closes the worker before a replacement can take frames", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready();
    camera.socket.send(frame(room.roomId).bytes);
    await until(() => worker.binaries.length === 1);
    f.advance(2001);
    expect((await camera.message("inference.error")).code).toBe("timeout");
    await until(() => worker.ended && camera.ended);
    expect(f.relay.stats().gpu).toMatchObject({
      leased: false,
      pending: 0,
      retired: 0,
    });
    const offline = await f.acquire(room);
    expect((await offline.message("gpu.status")).state).toBe("offline");
    await f.register();
    const restored = await f.acquire(room);
    expect((await restored.message("gpu.status")).state).toBe("ready");
  });
  it.each(["owner-loss", "owner-replaced", "room-end"])(
    "releases GPU authority on %s and never delivers a late result to a replacement",
    async (mode) => {
      const f = await fixture();
      const { worker, room, camera } = await f.ready();
      const sample = frame(room.roomId);
      camera.socket.send(sample.bytes);
      await until(() => worker.binaries.length === 1);
      if (mode === "owner-loss") room.owner!.socket.terminate();
      if (mode === "owner-replaced") {
        const owner = await f.connect("/ws", origin);
        owner.send({
          v: 2,
          type: "hello",
          role: "camera",
          roomId: room.roomId,
          token: room.ownerToken,
        });
        await owner.message("hello.ok");
      }
      if (mode === "room-end")
        expect(
          (
            await f.request(
              `/api/rooms/${room.roomId}`,
              undefined,
              room.ownerToken,
              "DELETE",
            )
          ).status,
        ).toBe(204);
      await until(() => camera.ended);
      expect(f.relay.stats().gpu.leased).toBe(false);
      worker.send(sample.result);
      await until(() => f.relay.stats().gpu.pending === 0);
      expect(worker.ended).toBe(false);
    },
  );
  it("worker loss clears the lease while browser owner and report channel stay usable", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready();
    camera.socket.send(frame(room.roomId).bytes);
    await until(() => worker.binaries.length === 1);
    worker.socket.terminate();
    expect((await camera.message("gpu.status")).state).toBe("offline");
    await until(() => camera.ended);
    room.owner!.send({ v: 2, type: "ping" });
    await room.owner!.message("pong");
    expect(f.relay.stats().rooms).toBe(1);
    expect(f.relay.stats().gpu.pending).toBe(0);
  });
  it("drops worker-bound preview pressure without queuing or blocking the owner channel", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready();
    const serverWorker = [...f.relay.gpuWss.clients][0];
    Object.defineProperty(serverWorker, "bufferedAmount", {
      configurable: true,
      get: () => 256 * 1024,
    });
    camera.socket.send(frame(room.roomId).bytes);
    expect((await camera.message("inference.error")).code).toBe("busy");
    expect(worker.binaries).toHaveLength(0);
    expect(f.relay.stats().gpu.pending).toBe(0);
    expect(worker.ended).toBe(false);
    room.owner!.send({ v: 2, type: "ping" });
    await room.owner!.message("pong");
  });
  it("GPU egress exhausts the same room cap and clears its paired session", async () => {
    const f = await fixture({ limits: { roomBytes: 1100 } });
    const { worker, room, camera } = await f.ready();
    const sample = frame(room.roomId);
    camera.socket.send(sample.bytes);
    await until(() => worker.binaries.length === 1);
    worker.send(sample.result);
    expect((await room.owner!.message("room.ended")).reason).toBe(
      "sharing_budget_exhausted",
    );
    await until(() => camera.ended);
    expect(f.relay.stats().rooms).toBe(0);
    expect(f.relay.stats().gpu.pending).toBe(0);
  });
  it("enforces hello/heartbeat deadlines and bounded one-Hz same-clock nonce echoes", async () => {
    const f = await fixture();
    const unauthenticated = await f.connect("/worker");
    f.advance(5001);
    await until(() => unauthenticated.ended);
    const { worker, camera } = await f.ready();
    camera.send({ v: 1, type: "gpu.ping", nonce: 123 });
    expect((await camera.message("gpu.pong")).nonce).toBe(123);
    camera.send({ v: 1, type: "gpu.ping", nonce: 124 });
    await delay(30);
    expect(camera.messages.some((message) => message.type === "gpu.pong")).toBe(
      false,
    );
    f.advance(1000);
    camera.send({ v: 1, type: "gpu.ping", nonce: 125 });
    expect((await camera.message("gpu.pong")).nonce).toBe(125);
    f.advance(45001);
    await until(() => worker.ended && camera.ended);
    expect(f.relay.stats().gpu.pending).toBe(0);
  });
  it.each(["prehello", "oversize", "wrongroom", "malformed"])(
    "rejects %s frames without forwarding bytes",
    async (mode) => {
      const f = await fixture();
      const worker = await f.register();
      const room = await f.create();
      const camera =
        mode === "prehello"
          ? await f.connect("/gpu", origin)
          : await f.acquire(room);
      if (mode !== "prehello") await camera.message("gpu.status");
      if (mode === "oversize")
        camera.socket.send(new Uint8Array(256 * 1024 + 1));
      else if (mode === "malformed")
        camera.socket.send(new Uint8Array([1, 2, 3, 4]));
      else
        camera.socket.send(
          frame(mode === "wrongroom" ? randomUUID() : room.roomId).bytes,
        );
      await until(() => camera.ended);
      expect(worker.binaries).toHaveLength(0);
    },
  );
});

it("GPU: actual relay process restart loses leases and requires new owner capabilities", async () => {
  const port = 25000 + Math.floor(Math.random() * 15000);
  const base = `http://127.0.0.1:${port}`;
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill();
    await done;
  }
  async function start() {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "backend/src/main.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          ALLOWED_ORIGINS: origin,
          ROADLENS_WORKER_SECRET: secret,
        },
        stdio: "ignore",
        windowsHide: true,
      },
    );
    cleanup.push(() => stop(child));
    const deadline = Date.now() + 10000;
    let health: Json | null = null;
    while (!health) {
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error("GPU relay process did not start");
      try {
        health = await (await fetch(base + "/healthz")).json();
      } catch {
        await delay(50);
      }
    }
    return { child, health };
  }
  const first = await start();
  const room = await (
    await fetch(base + "/api/rooms", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ v: 2, name: "restart" }),
    })
  ).json();
  const oldWorker = await new Client(
    base.replace("http:", "ws:") + "/worker",
  ).open();
  oldWorker.send({
    v: 1,
    type: "worker.register",
    role: "worker",
    secret,
    workerVersion: "1",
  });
  await oldWorker.message("worker.registered");
  await stop(first.child);
  const second = await start();
  expect(second.health.serverEpoch).not.toBe(first.health.serverEpoch);
  const worker = await new Client(
    base.replace("http:", "ws:") + "/worker",
  ).open();
  worker.send({
    v: 1,
    type: "worker.register",
    role: "worker",
    secret,
    workerVersion: "1",
  });
  expect((await worker.message("worker.registered")).serverEpoch).toBe(
    second.health.serverEpoch,
  );
  const oldCamera = await new Client(
    base.replace("http:", "ws:") + "/gpu",
    origin,
  ).open();
  oldCamera.send({
    v: 1,
    type: "gpu.hello",
    role: "camera",
    roomId: room.roomId,
    token: room.ownerToken,
  });
  await until(() => oldCamera.ended);
  expect(
    (
      await fetch(base + "/api/join", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ v: 2, code: room.pairingCode }),
      })
    ).status,
  ).toBe(404);
}, 20_000);
