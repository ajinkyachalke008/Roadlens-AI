import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { GPU_LIMITS } from "../../shared/src/limits.js";
import {
  CameraCancelSchema,
  GpuHelloSchema,
  GpuPingSchema,
  WorkerRegisterSchema,
  WorkerMessageSchema,
  decodeGpuFrame,
  sameGpuFrame,
  type GpuDescriptor,
  type GpuIdentity,
} from "../../shared/src/gpu.js";

export interface GpuRelayOptions {
  secret?: string;
  origins: ReadonlySet<string>;
  serverEpoch: string;
  now: () => number;
  authorizeCamera: (roomId: string, token: string) => boolean;
  roomExists: (roomId: string) => boolean;
  rateUpgrade: (address: string) => boolean;
  sendRoom: (
    roomId: string,
    socket: WebSocket,
    payload: string | Uint8Array,
    droppable?: boolean,
  ) => boolean;
  sendGlobal: (socket: WebSocket, payload: string) => boolean;
}
type Peer = {
  role: "camera" | "worker";
  helloDeadline: number;
  lastSeen: number;
  controls: number;
  controlStart: number;
};
type Worker = { socket: WebSocket; descriptor: GpuDescriptor | null };
type Lease = {
  roomId: string;
  socket: WebSocket;
  lastIdentity?: GpuIdentity;
  lastSubmittedAt: number;
  lastPing: number;
};
type Pending = {
  identity: GpuIdentity;
  camera: WebSocket | null;
  deadline: number;
};
const hash = (value: string) => createHash("sha256").update(value).digest();
const identity = (frame: GpuIdentity): GpuIdentity => ({
  roomId: frame.roomId,
  sourceId: frame.sourceId,
  captureEpoch: frame.captureEpoch,
  frameSeq: frame.frameSeq,
  frameId: frame.frameId,
  sourceTimeMs: frame.sourceTimeMs,
  sourceWidth: frame.sourceWidth,
  sourceHeight: frame.sourceHeight,
  encodedWidth: frame.encodedWidth,
  encodedHeight: frame.encodedHeight,
});

/** Only memberships/correlation metadata survive a message callback. Never retain image bytes. */
export function createGpuRelay(options: GpuRelayOptions) {
  if (
    options.secret !== undefined &&
    !/^[A-Za-z0-9_-]{43}$/.test(options.secret)
  )
    throw new Error(
      "ROADLENS_WORKER_SECRET must be a 32-byte base64url secret",
    );
  const secretDigest = options.secret ? hash(options.secret) : null;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: GPU_LIMITS.messageBytes,
    perMessageDeflate: false,
  });
  const peers = new Map<WebSocket, Peer>();
  let worker: Worker | null = null;
  let lease: Lease | null = null;
  let pending: Pending | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  function disconnect(socket: WebSocket, code = 1008) {
    socket.close(code, "GPU connection unavailable");
    const timer = setTimeout(() => socket.terminate(), 100);
    timer.unref();
  }
  function clearPending() {
    pending = null;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  function sendCamera(current: Lease, value: unknown) {
    return options.sendRoom(
      current.roomId,
      current.socket,
      JSON.stringify(value),
    );
  }
  function release(roomId: string, notifyWorker = false) {
    const current = lease;
    if (!current || current.roomId !== roomId) return;
    lease = null;
    if (pending?.camera === current.socket) pending.camera = null;
    if (notifyWorker && worker && options.roomExists(roomId))
      options.sendRoom(
        roomId,
        worker.socket,
        JSON.stringify({ v: 1, type: "camera.cancel", roomId }),
      );
    sendCamera(current, { v: 1, type: "gpu.status", state: "offline" });
    disconnect(current.socket, 1000);
  }
  function loseWorker(socket: WebSocket) {
    if (worker?.socket !== socket) return;
    worker = null;
    clearPending();
    if (lease) release(lease.roomId);
  }
  function unavailable(
    socket: WebSocket,
    roomId: string,
    state: "offline" | "busy",
  ) {
    options.sendRoom(
      roomId,
      socket,
      JSON.stringify({ v: 1, type: "gpu.status", state }),
    );
    disconnect(socket, 1000);
  }
  function state(): "offline" | "busy" | "ready" {
    if (!worker?.descriptor || worker.socket.readyState !== WebSocket.OPEN)
      return "offline";
    return lease || pending ? "busy" : "ready";
  }
  function maintain() {
    const time = options.now();
    for (const [socket, peer] of peers) {
      if (
        time >= peer.helloDeadline ||
        time - peer.lastSeen >= GPU_LIMITS.staleMs
      ) {
        loseWorker(socket);
        if (lease?.socket === socket) release(lease.roomId);
        socket.terminate();
      }
    }
    if (lease && !options.roomExists(lease.roomId)) release(lease.roomId);
    if (pending && time >= pending.deadline) {
      if (lease && pending.camera === lease.socket)
        sendCamera(lease, {
          v: 1,
          type: "inference.error",
          roomId: pending.identity.roomId,
          frameId: pending.identity.frameId,
          code: "timeout",
        });
      const currentWorker = worker?.socket;
      if (currentWorker) {
        loseWorker(currentWorker);
        disconnect(currentWorker, 1011);
      } else clearPending();
    }
  }
  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    const time = options.now();
    peers.set(socket, {
      role: req.url === "/worker" ? "worker" : "camera",
      helloDeadline: time + GPU_LIMITS.helloMs,
      lastSeen: time,
      controls: 0,
      controlStart: time,
    });
    socket.on("error", () => socket.terminate());
    socket.on("pong", () => {
      const peer = peers.get(socket);
      if (peer) peer.lastSeen = options.now();
    });
    socket.on("close", () => {
      peers.delete(socket);
      loseWorker(socket);
      if (lease?.socket === socket) release(lease.roomId);
    });
    socket.on("message", (raw: RawData, binary: boolean) => {
      try {
        maintain();
        const peer = peers.get(socket);
        if (!peer || socket.readyState !== WebSocket.OPEN) return;
        const bytes = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : raw;
        if (peer.helloDeadline !== Infinity) {
          if (
            binary ||
            bytes.length > GPU_LIMITS.textBytes ||
            options.now() >= peer.helloDeadline
          )
            throw new Error("hello");
          const value = JSON.parse(bytes.toString("utf8"));
          if (peer.role === "worker") {
            const hello = WorkerRegisterSchema.parse(value);
            if (
              !secretDigest ||
              !timingSafeEqual(hash(hello.secret), secretDigest) ||
              worker
            )
              throw new Error("worker authority");
            worker = { socket, descriptor: null };
            options.sendGlobal(
              socket,
              JSON.stringify({
                v: 1,
                type: "worker.registered",
                serverEpoch: options.serverEpoch,
              }),
            );
          } else {
            const hello = GpuHelloSchema.parse(value);
            if (!options.authorizeCamera(hello.roomId, hello.token))
              throw new Error("camera authority");
            const available = state();
            if (available !== "ready") {
              unavailable(socket, hello.roomId, available);
              return;
            }
            lease = {
              roomId: hello.roomId,
              socket,
              lastSubmittedAt: -Infinity,
              lastPing: -Infinity,
            };
            sendCamera(lease, {
              v: 1,
              type: "gpu.status",
              state: "ready",
              descriptor: worker!.descriptor,
            });
          }
          peer.helloDeadline = Infinity;
          peer.lastSeen = options.now();
          return;
        }
        peer.lastSeen = options.now();
        // Count every authenticated message before parsing either envelope format.
        // Rejected/pending binary frames must not bypass the message-flood bound.
        if (options.now() - peer.controlStart >= 1000) {
          peer.controlStart = options.now();
          peer.controls = 0;
        }
        if (++peer.controls > GPU_LIMITS.maxHz + 5) throw new Error("rate");
        if (binary) {
          if (peer.role !== "camera" || lease?.socket !== socket)
            throw new Error("role");
          const frame = decodeGpuFrame(bytes).header;
          if (
            frame.roomId !== lease.roomId ||
            !options.roomExists(frame.roomId)
          )
            throw new Error("room");
          const previous = lease.lastIdentity;
          if (
            previous?.captureEpoch === frame.captureEpoch &&
            (previous.sourceId !== frame.sourceId ||
              previous.sourceWidth !== frame.sourceWidth ||
              previous.sourceHeight !== frame.sourceHeight)
          )
            throw new Error("geometry");
          if (
            pending ||
            options.now() - lease.lastSubmittedAt < 1000 / GPU_LIMITS.maxHz ||
            (previous?.captureEpoch === frame.captureEpoch &&
              (frame.frameSeq <= previous.frameSeq ||
                frame.sourceTimeMs <= previous.sourceTimeMs))
          ) {
            sendCamera(lease, {
              v: 1,
              type: "inference.error",
              roomId: frame.roomId,
              frameId: frame.frameId,
              code: "busy",
            });
            return;
          }
          if (!worker?.descriptor) {
            release(lease.roomId);
            return;
          }
          if (!options.sendRoom(frame.roomId, worker.socket, bytes, true)) {
            if (lease)
              sendCamera(lease, {
                v: 1,
                type: "inference.error",
                roomId: frame.roomId,
                frameId: frame.frameId,
                code: "busy",
              });
            return;
          }
          lease.lastSubmittedAt = options.now();
          lease.lastIdentity = identity(frame);
          pending = {
            identity: identity(frame),
            camera: socket,
            deadline: options.now() + GPU_LIMITS.frameTimeoutMs,
          };
          pendingTimer = setTimeout(maintain, GPU_LIMITS.frameTimeoutMs);
          pendingTimer.unref();
          return;
        }
        if (bytes.length > GPU_LIMITS.textBytes) throw new Error("text size");
        const value = JSON.parse(bytes.toString("utf8"));
        if (peer.role === "camera") {
          if (lease?.socket !== socket) throw new Error("lease");
          const ping = GpuPingSchema.safeParse(value);
          if (ping.success) {
            if (options.now() - lease.lastPing >= 1000) {
              lease.lastPing = options.now();
              sendCamera(lease, {
                v: 1,
                type: "gpu.pong",
                nonce: ping.data.nonce,
              });
            }
            return;
          }
          const cancel = CameraCancelSchema.parse(value);
          if (cancel.roomId !== lease.roomId) throw new Error("room");
          release(lease.roomId, true);
          return;
        }
        if (worker?.socket !== socket) throw new Error("worker");
        const message = WorkerMessageSchema.parse(value);
        if (message.type === "worker.ready") {
          if (lease || pending) throw new Error("model busy");
          const { modelId, modelSha256, runtime, inputSize } = message;
          worker.descriptor = { modelId, modelSha256, runtime, inputSize };
          return;
        }
        if (message.type === "worker.heartbeat") {
          const pong = JSON.stringify({ v: 1, type: "worker.pong" });
          if (lease) options.sendRoom(lease.roomId, socket, pong);
          else options.sendGlobal(socket, pong);
          return;
        }
        if (
          message.type !== "inference.result" &&
          message.type !== "inference.error"
        )
          throw new Error("role");
        if (!pending || !worker.descriptor) throw new Error("correlation");
        if (message.type === "inference.result") {
          if (
            !sameGpuFrame(pending.identity, message) ||
            (Object.keys(worker.descriptor) as (keyof GpuDescriptor)[]).some(
              (key) => message[key] !== worker!.descriptor![key],
            )
          )
            throw new Error("result mismatch");
        } else if (
          message.roomId !== pending.identity.roomId ||
          message.frameId !== pending.identity.frameId
        )
          throw new Error("error mismatch");
        if (lease && pending.camera === lease.socket)
          sendCamera(lease, message);
        clearPending();
      } catch {
        loseWorker(socket);
        if (lease?.socket === socket) release(lease.roomId);
        disconnect(socket);
      }
    });
  });
  const heartbeat = setInterval(() => {
    maintain();
    for (const socket of peers.keys())
      if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, GPU_LIMITS.heartbeatMs);
  heartbeat.unref();
  return {
    wss,
    status: () => ({ enabled: !!secretDigest, state: state() }),
    stats: () => ({
      sockets: peers.size,
      leased: !!lease,
      pending: pending ? 1 : 0,
      retired: pending && !pending.camera ? 1 : 0,
    }),
    maintain,
    endRoom: (roomId: string) => release(roomId),
    ownerDisconnected: (roomId: string) => release(roomId),
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      if (req.url !== "/gpu" && req.url !== "/worker") return false;
      const originAllowed =
        req.url === "/worker"
          ? req.headers.origin === undefined
          : !!req.headers.origin && options.origins.has(req.headers.origin);
      if (
        closed ||
        !secretDigest ||
        !originAllowed ||
        wss.clients.size >= 8 ||
        !options.rateUpgrade(req.socket.remoteAddress ?? "unknown")
      )
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      else
        wss.handleUpgrade(req, socket, head, (ws) =>
          wss.emit("connection", ws, req),
        );
      return true;
    },
    async close() {
      closed = true;
      clearInterval(heartbeat);
      clearPending();
      lease = null;
      worker = null;
      for (const socket of wss.clients) socket.terminate();
      peers.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
