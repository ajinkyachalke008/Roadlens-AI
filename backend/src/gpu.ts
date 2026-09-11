import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { GPU_LIMITS, PLATE_LIMITS } from "../../shared/src/limits.js";
import {
  decodePlateFrame,
  isPlateFrame,
  samePlateRequest,
  type PlateDescriptor,
  type PlateIdentity,
} from "../../shared/src/plates.js";
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
type Worker = {
  socket: WebSocket;
  descriptor: GpuDescriptor | null;
  /** Present only when this worker advertised a loaded plate pipeline. */
  plate: PlateDescriptor | null;
};
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
type PlatePending = {
  identity: PlateIdentity;
  camera: WebSocket | null;
  deadline: number;
};
/**
 * Bounded analysis depth. The camera client and the worker enforce the same
 * ceiling, so no stage queues frames: the worker runs one CUDA call with at
 * most one newest frame behind it. Identities are correlated exactly, never by
 * arrival order, so an out-of-order completion cannot be attributed elsewhere.
 */
const maxInFlight = GPU_LIMITS.maxInFlight;
const hash = (value: string) => createHash("sha256").update(value).digest();
const plateIdentity = (frame: PlateIdentity): PlateIdentity => ({
  roomId: frame.roomId,
  sourceId: frame.sourceId,
  captureEpoch: frame.captureEpoch,
  requestId: frame.requestId,
  frameSeq: frame.frameSeq,
  frameId: frame.frameId,
  trackId: frame.trackId,
  sourceTimeMs: frame.sourceTimeMs,
});
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
  /** Submitted, uncompleted identities by frameId. At most `maxInFlight`. */
  const pending = new Map<string, Pending>();
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Plate requests are tracked separately from analysis frames and capped at
   * `PLATE_LIMITS.maxInFlight`, so a slow or absent plate pipeline can neither
   * consume the analysis depth budget nor delay an analysis result.
   */
  const platePending = new Map<string, PlatePending>();
  let plateTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set when a plate request timed out. The worker is *not* condemned for it:
   * plate work is an enhancement, and taking traffic detection down over an
   * unreadable plate would be exactly the wrong trade. Further plate requests
   * are refused for the rest of this lease instead.
   */
  let plateDisabled = false;
  let closed = false;
  function disconnect(socket: WebSocket, code = 1008) {
    socket.close(code, "GPU connection unavailable");
    const timer = setTimeout(() => socket.terminate(), 100);
    timer.unref();
  }
  function clearPending() {
    pending.clear();
    platePending.clear();
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    if (plateTimer) clearTimeout(plateTimer);
    plateTimer = null;
  }
  /** Oldest deadline first; the map preserves submission order. */
  function nextDeadline() {
    for (const entry of pending.values()) return entry.deadline;
    return null;
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
    plateDisabled = false;
    for (const entry of pending.values())
      if (entry.camera === current.socket) entry.camera = null;
    // Retire rather than forget. The worker cannot cancel a running read, so its
    // reply is still coming; an entry that no longer exists would look like an
    // uncorrelated message and cost the operator their worker over a routine
    // cancel. The retired entry is discarded on arrival, or by its own timeout.
    for (const entry of platePending.values())
      if (entry.camera === current.socket) entry.camera = null;
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
    return lease || pending.size ? "busy" : "ready";
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
    // A plate request that overran its deadline reports back and disables plate
    // work for this lease. It deliberately does not condemn the worker, so an
    // unreadable plate can never cost the operator their traffic detection.
    for (const [requestId, entry] of platePending)
      if (time >= entry.deadline) {
        platePending.delete(requestId);
        plateDisabled = true;
        if (lease && entry.camera === lease.socket)
          sendCamera(lease, {
            v: 1,
            type: "plate.error",
            roomId: entry.identity.roomId,
            requestId,
            code: "timeout",
          });
      }
    // A single expiry condemns the worker: a native call that overran its
    // deadline cannot be cancelled, so every outstanding identity is abandoned.
    const expired = [...pending.values()].filter(
      (entry) => time >= entry.deadline,
    );
    if (expired.length) {
      for (const entry of expired)
        if (lease && entry.camera === lease.socket)
          sendCamera(lease, {
            v: 1,
            type: "inference.error",
            roomId: entry.identity.roomId,
            frameId: entry.identity.frameId,
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
            worker = { socket, descriptor: null, plate: null };
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
              // Omitted entirely when this worker has no plate pipeline, so the
              // message stays byte identical to what a plate-free build sends.
              ...(worker!.plate ? { plate: worker!.plate } : {}),
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
        // Analysis frames, pings and plate requests share one flood bound, so
        // the plate budget is added explicitly rather than eating into analysis.
        if (
          ++peer.controls >
          GPU_LIMITS.maxHz + 5 + Math.ceil(1000 / PLATE_LIMITS.minIntervalMs)
        )
          throw new Error("rate");
        if (binary && isPlateFrame(bytes)) {
          if (peer.role !== "camera" || lease?.socket !== socket)
            throw new Error("role");
          const request = decodePlateFrame(bytes).header;
          if (
            request.roomId !== lease.roomId ||
            !options.roomExists(request.roomId)
          )
            throw new Error("room");
          const refuse = (code: "busy" | "unavailable") =>
            sendCamera(lease!, {
              v: 1,
              type: "plate.error",
              roomId: request.roomId,
              requestId: request.requestId,
              code,
            });
          if (!worker?.descriptor || !worker.plate || plateDisabled) {
            refuse("unavailable");
            return;
          }
          // One plate task system wide. A camera that asks again before the
          // previous answer arrives is told so immediately rather than queued.
          if (
            platePending.size >= PLATE_LIMITS.maxInFlight ||
            platePending.has(request.requestId) ||
            !options.sendRoom(request.roomId, worker.socket, bytes, true)
          ) {
            refuse("busy");
            return;
          }
          platePending.set(request.requestId, {
            identity: plateIdentity(request),
            camera: socket,
            deadline: options.now() + PLATE_LIMITS.requestTimeoutMs,
          });
          // Own timer, so the slot is released on its own deadline rather than
          // whenever the next message happens to run maintain().
          if (plateTimer) clearTimeout(plateTimer);
          plateTimer = setTimeout(maintain, PLATE_LIMITS.requestTimeoutMs);
          plateTimer.unref();
          return;
        }
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
          // Depth, rate and strict per-epoch monotonicity. Admitting only
          // strictly newer identities is what lets the camera treat an
          // out-of-order completion as superseded rather than as truth.
          if (
            pending.size >= maxInFlight ||
            pending.has(frame.frameId) ||
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
          pending.set(frame.frameId, {
            identity: identity(frame),
            camera: socket,
            deadline: options.now() + GPU_LIMITS.frameTimeoutMs,
          });
          if (pendingTimer) clearTimeout(pendingTimer);
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
          if (lease || pending.size) throw new Error("model busy");
          const { modelId, modelSha256, runtime, inputSize } = message;
          worker.descriptor = { modelId, modelSha256, runtime, inputSize };
          worker.plate = message.plate ?? null;
          return;
        }
        if (message.type === "worker.heartbeat") {
          const pong = JSON.stringify({ v: 1, type: "worker.pong" });
          if (lease) options.sendRoom(lease.roomId, socket, pong);
          else options.sendGlobal(socket, pong);
          return;
        }
        if (message.type === "plate.result" || message.type === "plate.error") {
          const outstandingPlate = platePending.get(message.requestId);
          if (!outstandingPlate) throw new Error("plate correlation");
          if (
            message.type === "plate.result"
              ? !samePlateRequest(outstandingPlate.identity, message)
              : message.roomId !== outstandingPlate.identity.roomId
          )
            throw new Error("plate mismatch");
          platePending.delete(message.requestId);
          if (!platePending.size && plateTimer) {
            clearTimeout(plateTimer);
            plateTimer = null;
          }
          if (lease && outstandingPlate.camera === lease.socket)
            sendCamera(lease, message);
          return;
        }
        if (
          message.type !== "inference.result" &&
          message.type !== "inference.error"
        )
          throw new Error("role");
        const outstanding = pending.get(message.frameId);
        if (!outstanding || !worker.descriptor)
          throw new Error("correlation");
        if (message.type === "inference.result") {
          if (
            !sameGpuFrame(outstanding.identity, message) ||
            (Object.keys(worker.descriptor) as (keyof GpuDescriptor)[]).some(
              (key) => message[key] !== worker!.descriptor![key],
            )
          )
            throw new Error("result mismatch");
        } else if (message.roomId !== outstanding.identity.roomId)
          throw new Error("error mismatch");
        if (lease && outstanding.camera === lease.socket)
          sendCamera(lease, message);
        pending.delete(message.frameId);
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = null;
        const deadline = nextDeadline();
        if (deadline !== null) {
          pendingTimer = setTimeout(
            maintain,
            Math.max(0, deadline - options.now()),
          );
          pendingTimer.unref();
        }
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
      pending: pending.size,
      retired: [...pending.values()].filter((entry) => !entry.camera).length,
      maxInFlight,
      plateEnabled: !!worker?.plate && !plateDisabled,
      platePending: platePending.size,
      plateMaxInFlight: PLATE_LIMITS.maxInFlight,
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
