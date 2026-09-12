import express, { type Request, type Response } from "express";
import { createServer } from "node:http";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { resolve, extname } from "node:path";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { z } from "zod";
import { LIMITS } from "../../shared/src/limits.js";
import { HelloSchema, ControlSchema } from "../../shared/src/schemas.js";
import { decodePacket } from "../../shared/src/packets.js";
import { createGpuRelay } from "./gpu.js";

type Bounds = { [K in keyof typeof LIMITS]: number };
export interface RelayConfig {
  origins: string[];
  staticDir?: string;
  now?: () => number;
  limits?: Partial<Bounds>;
  workerSecret?: string;
}
type Member = {
  id: string;
  digest: Buffer;
  socket?: WebSocket;
  expiresAt: number;
};
type Pending = {
  viewerId: string;
  response: string;
  expiresAt: number;
  evidenceId?: string;
  batches: number;
  reportCount: number;
  dispatched?: boolean;
};
type RetiredRequest = {
  response: string;
  evidenceId?: string;
  expiresAt: number;
};
type Room = {
  id: string;
  owner: Member;
  viewers: Map<string, Member>;
  code: string;
  codeExpiresAt: number;
  expiresAt: number;
  ownerDeadline: number;
  status: string;
  requests: Map<string, Pending>;
  retiredRequests: Map<string, RetiredRequest>;
  snapshotActive?: { requestId: string; expiresAt: number };
  bytes: number;
  lastPreview: number;
  epoch?: string;
  frameSeq: number;
};
type Binding = {
  room: Room;
  member: Member;
  role: "camera" | "viewer";
  lastSeen: number;
  controlStart: number;
  controls: number;
};
const digest = (token: string) => createHash("sha256").update(token).digest();
const equalToken = (token: string, expected: Buffer) =>
  timingSafeEqual(digest(token), expected);
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const errorBody = (
  code: string,
  message: string,
  requestId?: string,
  retryAfterMs?: number,
) => ({
  v: 2,
  type: "error",
  code,
  message,
  ...(requestId ? { requestId } : {}),
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

/** A single ephemeral relay. No traffic content is retained after transport. */
export function createRelay(config: RelayConfig) {
  const limits: Bounds = { ...LIMITS, ...config.limits };
  const now = config.now ?? Date.now;
  const origins = new Set(config.origins);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol))
      throw new Error("Configure exact HTTP origins");
  }
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false); // Never trust client-supplied X-Forwarded-For. Render deployment is deliberately conservative.
  const server = createServer(app);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.messageBytes,
    perMessageDeflate: false,
  });
  const serverEpoch = randomUUID();
  const rooms = new Map<string, Room>();
  const codes = new Map<string, Room>();
  const bindings = new Map<WebSocket, Binding>();
  const deadlines = new Map<WebSocket, number>();
  const rates = new Map<string, { start: number; count: number }>();
  let bootBytes = 0;
  let closed = false;
  function rate(key: string, max: number) {
    const time = now();
    for (const [k, item] of rates)
      if (time - item.start >= 60_000) rates.delete(k);
    let entry = rates.get(key);
    if (!entry) {
      if (rates.size >= limits.rateEntries) return false;
      entry = { start: time, count: 0 };
      rates.set(key, entry);
    }
    entry.count++;
    return entry.count <= max;
  }
  function budget(room: Room) {
    return {
      roomBytesRemaining: Math.max(0, limits.roomBytes - room.bytes),
      processBytesRemaining: Math.max(0, limits.processBytes - bootBytes),
    };
  }
  function disconnect(
    socket: WebSocket,
    code = 1008,
    reason = "Session unavailable",
  ) {
    socket.close(code, reason);
    const timer = setTimeout(() => socket.terminate(), 100);
    timer.unref();
  }
  function endRoom(room: Room, reason: string) {
    if (!rooms.delete(room.id)) return;
    gpu.endRoom(room.id);
    codes.delete(room.code);
    room.requests.clear();
    room.retiredRequests.clear();
    room.snapshotActive = undefined;
    const packet = JSON.stringify({ v: 2, type: "room.ended", reason });
    for (const member of [room.owner, ...room.viewers.values()])
      if (member.socket) {
        // A final small end notice is transport control overhead, not content budget.
        if (
          member.socket.readyState === WebSocket.OPEN &&
          member.socket.bufferedAmount <= limits.bufferBytes
        )
          member.socket.send(packet);
        disconnect(member.socket, 1000, "Room ended");
      }
    room.viewers.clear();
  }
  function send(
    room: Room,
    socket: WebSocket | undefined,
    payload: string | Uint8Array,
    preview = false,
  ): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN || !rooms.has(room.id))
      return false;
    const size =
      typeof payload === "string"
        ? Buffer.byteLength(payload)
        : payload.byteLength;
    if (socket.bufferedAmount + size > limits.bufferBytes) {
      if (!preview) disconnect(socket, 1013, "Reconnect for source resync");
      return false;
    }
    if (
      room.bytes + size > limits.roomBytes ||
      bootBytes + size > limits.processBytes
    ) {
      if (bootBytes + size > limits.processBytes)
        for (const current of [...rooms.values()])
          endRoom(current, "sharing_budget_exhausted");
      else endRoom(room, "sharing_budget_exhausted");
      return false;
    }
    room.bytes += size;
    bootBytes += size;
    socket.send(payload, { binary: typeof payload !== "string" }, (error) => {
      if (error) socket.terminate();
    });
    return true;
  }
  function control(room: Room, socket: WebSocket | undefined, value: unknown) {
    return send(room, socket, JSON.stringify(value));
  }
  function broadcast(room: Room, value: unknown) {
    const packet = JSON.stringify(value);
    for (const member of room.viewers.values())
      send(room, member.socket, packet);
  }
  const gpu = createGpuRelay({
    secret: config.workerSecret,
    origins,
    serverEpoch,
    now,
    authorizeCamera: (roomId, token) => {
      const room = rooms.get(roomId);
      return (
        !!room &&
        room.expiresAt > now() &&
        room.owner.socket?.readyState === WebSocket.OPEN &&
        equalToken(token, room.owner.digest)
      );
    },
    roomExists: (roomId) => {
      const room = rooms.get(roomId);
      return (
        !!room &&
        room.expiresAt > now() &&
        room.owner.socket?.readyState === WebSocket.OPEN
      );
    },
    rateUpgrade: (address) => rate(`gpu-upgrade:${address}`, 60),
    sendRoom: (roomId, socket, payload, droppable) => {
      const room = rooms.get(roomId);
      return !!room && send(room, socket, payload, droppable);
    },
    sendGlobal: (socket, payload) => {
      const size = Buffer.byteLength(payload);
      if (socket.readyState !== WebSocket.OPEN) return false;
      if (
        socket.bufferedAmount + size > limits.bufferBytes ||
        bootBytes + size > limits.processBytes
      ) {
        if (bootBytes + size > limits.processBytes)
          for (const room of [...rooms.values()])
            endRoom(room, "sharing_budget_exhausted");
        disconnect(socket, 1013);
        return false;
      }
      bootBytes += size;
      socket.send(payload, (error) => {
        if (error) socket.terminate();
      });
      return true;
    },
  });
  function viewerCount(room: Room) {
    return [...room.viewers.values()].filter(
      (m) => m.socket?.readyState === WebSocket.OPEN,
    ).length;
  }
  function viewersChanged(room: Room) {
    control(room, room.owner.socket, {
      v: 2,
      type: "viewers.changed",
      viewerCount: viewerCount(room),
    });
  }
  function retireRequest(room: Room, requestId: string) {
    const pending = room.requests.get(requestId);
    if (!pending) return;
    room.requests.delete(requestId);
    room.retiredRequests.set(requestId, {
      response: pending.response,
      ...(pending.evidenceId ? { evidenceId: pending.evidenceId } : {}),
      expiresAt: Math.min(
        room.expiresAt,
        now() + limits.ownerGraceMs + limits.requestMs,
      ),
    });
    while (room.retiredRequests.size > limits.requests * 2)
      room.retiredRequests.delete(room.retiredRequests.keys().next().value!);
  }
  function correlated(
    room: Room,
    requestId: string,
    response: string,
    evidenceId?: string,
  ): Pending | null {
    let pending = room.requests.get(requestId);
    if (pending && pending.expiresAt <= now()) {
      retireRequest(room, requestId);
      pending = undefined;
    }
    if (!pending) {
      const retired = room.retiredRequests.get(requestId);
      if (
        retired &&
        retired.expiresAt > now() &&
        retired.response === response &&
        retired.evidenceId === evidenceId
      )
        return null; // A disconnected/revoked/timed-out requester cannot turn its late reply into owner loss.
      throw new Error("correlation");
    }
    if (
      pending.response !== response ||
      pending.evidenceId !== evidenceId ||
      (response === "state.snapshot" && !pending.dispatched)
    )
      throw new Error("correlation");
    return pending;
  }
  function dispatchSnapshot(room: Room) {
    if (
      room.snapshotActive ||
      room.owner.socket?.readyState !== WebSocket.OPEN ||
      !rooms.has(room.id)
    )
      return;
    for (const [requestId, pending] of room.requests) {
      if (pending.response !== "state.snapshot" || pending.dispatched) continue;
      if (
        pending.expiresAt <= now() ||
        room.viewers.get(pending.viewerId)?.socket?.readyState !==
          WebSocket.OPEN
      ) {
        retireRequest(room, requestId);
        continue;
      }
      pending.dispatched = true;
      room.snapshotActive = { requestId, expiresAt: pending.expiresAt };
      control(room, room.owner.socket, {
        v: 2,
        type: "state.request",
        requestId,
        requesterId: pending.viewerId,
      });
      return;
    }
  }
  function finishSnapshot(room: Room, requestId: string) {
    if (room.snapshotActive?.requestId !== requestId) return;
    room.snapshotActive = undefined;
    dispatchSnapshot(room);
  }
  function snapshotRequest(room: Room, viewerId: string, requestId: string) {
    room.requests.set(requestId, {
      viewerId,
      response: "state.snapshot",
      expiresAt: now() + limits.requestMs,
      batches: 0,
      reportCount: 0,
      dispatched: false,
    });
    dispatchSnapshot(room);
  }
  function recoverViewers(room: Room) {
    // A source socket can reconnect while viewer sockets remain open. Their missed local reports need a new source snapshot.
    for (const [requestId, pending] of room.requests) {
      control(
        room,
        room.viewers.get(pending.viewerId)?.socket,
        errorBody(
          "source_offline",
          "Camera reconnected; previous request was interrupted.",
          requestId,
        ),
      );
      retireRequest(room, requestId);
    }
    room.snapshotActive = undefined;
    for (const viewer of room.viewers.values()) {
      if (
        viewer.socket?.readyState === WebSocket.OPEN &&
        room.requests.size < limits.requests
      )
        snapshotRequest(room, viewer.id, randomUUID());
    }
  }
  function newCode(room: Room) {
    codes.delete(room.code);
    let code: string;
    do {
      code = [...randomBytes(8)].map((byte) => alphabet[byte & 31]).join("");
    } while (codes.has(code));
    room.code = code;
    room.codeExpiresAt = Math.min(now() + limits.codeTtlMs, room.expiresAt);
    codes.set(code, room);
    return {
      pairingCode: `${code.slice(0, 4)}-${code.slice(4)}`,
      codeExpiresAt: room.codeExpiresAt,
      roomExpiresAt: room.expiresAt,
      serverEpoch,
    };
  }
  function authorized(req: Request, res: Response): Room | undefined {
    const room = rooms.get(String(req.params.id));
    const bearer = req.headers.authorization;
    if (
      !room ||
      room.expiresAt <= now() ||
      !bearer?.startsWith("Bearer ") ||
      !equalToken(bearer.slice(7), room.owner.digest)
    ) {
      res
        .status(403)
        .json(
          errorBody(
            "pairing_unavailable",
            "Sharing is unavailable. Create a new code.",
          ),
        );
      return;
    }
    return room;
  }
  function emptyBody(req: Request, res: Response) {
    if (
      req.body !== undefined &&
      !z
        .object({ v: z.literal(2).optional() })
        .strict()
        .safeParse(req.body).success
    ) {
      res
        .status(400)
        .json(
          errorBody(
            "invalid_request",
            "This action accepts only protocol version 2.",
          ),
        );
      return false;
    }
    return true;
  }
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Permissions-Policy",
      "camera=(self), microphone=(), geolocation=()",
    );
    if (req.path.startsWith("/api/") || req.path === "/healthz")
      res.setHeader("Cache-Control", "no-store");
    if (
      req.path.startsWith("/api/") &&
      (!req.headers.origin || !origins.has(req.headers.origin))
    ) {
      res
        .status(403)
        .json(errorBody("invalid_origin", "This website is not allowed."));
      return;
    }
    if (req.headers.origin && origins.has(req.headers.origin)) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    if (
      req.method === "POST" &&
      req.path.startsWith("/api/") &&
      !req.is("application/json")
    ) {
      res
        .status(415)
        .json(errorBody("invalid_request", "Use application/json."));
      return;
    }
    next();
  });
  app.use(
    express.json({ limit: 2048, strict: true, type: "application/json" }),
  );
  app.get("/healthz", (_req, res) =>
    res.json({ healthy: true, v: 2, serverEpoch }),
  );
  const publicConfig = () => ({ v: 2, limits, gpu: gpu.status() });
  app.get("/api/config", (_req, res) => res.json(publicConfig()));
  // Same-origin browser GET requests can omit Origin. POST keeps the exact-Origin
  // policy intact while allowing the explicit camera-start capability probe.
  app.post("/api/config", (req, res) => {
    if (
      !z
        .object({ v: z.literal(2) })
        .strict()
        .safeParse(req.body).success
    ) {
      res
        .status(400)
        .json(
          errorBody(
            "invalid_request",
            "A versioned config request is required.",
          ),
        );
      return;
    }
    res.json(publicConfig());
  });
  app.post("/api/rooms", (req, res) => {
    if (!rate(`create:${req.socket.remoteAddress}`, 3)) {
      res
        .status(429)
        .json(
          errorBody(
            "rate_limited",
            "Too many rooms. Retry in one minute.",
            undefined,
            60_000,
          ),
        );
      return;
    }
    if (
      !z
        .object({ v: z.literal(2), name: z.string().trim().min(1).max(80) })
        .strict()
        .safeParse(req.body).success
    ) {
      res
        .status(400)
        .json(errorBody("invalid_request", "A short camera name is required."));
      return;
    }
    maintain();
    if (rooms.size >= limits.rooms || bootBytes >= limits.processBytes) {
      res
        .status(503)
        .json(
          errorBody(
            "pairing_unavailable",
            "Relay capacity is temporarily full.",
          ),
        );
      return;
    }
    const ownerToken = randomBytes(32).toString("base64url");
    const room: Room = {
      id: randomUUID(),
      owner: {
        id: randomUUID(),
        digest: digest(ownerToken),
        expiresAt: now() + limits.roomTtlMs,
      },
      viewers: new Map(),
      code: "",
      codeExpiresAt: 0,
      expiresAt: now() + limits.roomTtlMs,
      ownerDeadline: now() + limits.reservationMs,
      status: "offline",
      requests: new Map(),
      retiredRequests: new Map(),
      bytes: 0,
      lastPreview: -Infinity,
      frameSeq: -1,
    };
    rooms.set(room.id, room);
    res
      .status(201)
      .json({ v: 2, roomId: room.id, ownerToken, ...newCode(room) });
  });
  app.post("/api/join", (req, res) => {
    if (
      !rate(`join:${req.socket.remoteAddress}`, 10) ||
      !rate("join:global", 30)
    ) {
      res
        .status(429)
        .json(
          errorBody(
            "rate_limited",
            "Too many join attempts. Retry in one minute.",
            undefined,
            60_000,
          ),
        );
      return;
    }
    const parsed = z
      .object({ v: z.literal(2), code: z.string().max(32) })
      .strict()
      .safeParse(req.body);
    const code = parsed.success
      ? parsed.data.code.toUpperCase().replace(/[\s-]/g, "")
      : "";
    maintain();
    const room = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/.test(code)
      ? codes.get(code)
      : undefined;
    if (
      !room ||
      now() >= room.codeExpiresAt ||
      room.viewers.size >= limits.viewers
    ) {
      res
        .status(404)
        .json(
          errorBody(
            "pairing_unavailable",
            "Code unavailable, expired, or viewers full.",
          ),
        );
      return;
    }
    const viewerToken = randomBytes(32).toString("base64url");
    const viewerId = randomUUID();
    room.viewers.set(viewerId, {
      id: viewerId,
      digest: digest(viewerToken),
      expiresAt: now() + limits.reservationMs,
    });
    res.json({
      v: 2,
      roomId: room.id,
      viewerId,
      viewerToken,
      roomExpiresAt: room.expiresAt,
      serverEpoch,
    });
  });
  app.post("/api/rooms/:id/code", (req, res) => {
    const room = authorized(req, res);
    if (!room || !emptyBody(req, res)) return;
    if (!rate(`owner:${room.id}`, 10)) {
      res.status(429).json(errorBody("rate_limited", "Retry in one minute."));
      return;
    }
    res.json({ v: 2, ...newCode(room) });
  });
  app.post("/api/rooms/:id/revoke-viewers", (req, res) => {
    const room = authorized(req, res);
    if (!room || !emptyBody(req, res)) return;
    if (!rate(`owner:${room.id}`, 10)) {
      res.status(429).json(errorBody("rate_limited", "Retry in one minute."));
      return;
    }
    for (const member of room.viewers.values())
      if (member.socket) {
        control(room, member.socket, {
          v: 2,
          type: "room.ended",
          reason: "revoked",
        });
        disconnect(member.socket, 1000, "Viewer revoked");
      }
    room.viewers.clear();
    for (const requestId of room.requests.keys())
      retireRequest(room, requestId);
    viewersChanged(room);
    res.json({ v: 2, ...newCode(room) });
  });
  app.delete("/api/rooms/:id", (req, res) => {
    const room = authorized(req, res);
    if (!room) return;
    endRoom(room, "owner_ended");
    res.status(204).end();
  });
  app.use("/api", (_req, res) =>
    res.status(404).json(errorBody("invalid_request", "Unknown endpoint.")),
  );
  if (config.staticDir) {
    const directory = resolve(config.staticDir);
    app.use(
      express.static(directory, {
        index: "index.html",
        dotfiles: "deny",
        setHeaders: (res, path) => {
          if (path.endsWith(".onnx"))
            res.setHeader("Content-Type", "application/octet-stream");
          if (path.endsWith(".wasm"))
            res.setHeader("Content-Type", "application/wasm");
        },
      }),
    );
    app.get("/{*path}", (req, res, next) => {
      if (
        extname(req.path) ||
        !["/", "/camera", "/viewer", "/admin"].includes(req.path)
      ) {
        next();
        return;
      }
      res.sendFile(resolve(directory, "index.html"));
    });
  }
  app.use((_req, res) =>
    res.status(404).json(errorBody("invalid_request", "Not found.")),
  );
  app.use(
    (
      _error: unknown,
      _req: Request,
      res: Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(400)
        .json(errorBody("invalid_request", "Invalid or oversized JSON."));
    },
  );
  server.on("upgrade", (req, socket, head) => {
    if (gpu.handleUpgrade(req, socket, head)) return;
    if (
      closed ||
      req.url !== "/ws" ||
      !req.headers.origin ||
      !origins.has(req.headers.origin) ||
      wss.clients.size >= limits.rooms * (limits.viewers + 1) + 10 ||
      !rate(`upgrade:${req.socket.remoteAddress}`, 60)
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (socket) => {
    deadlines.set(socket, now() + limits.helloMs);
    socket.on("error", () => {
      socket.terminate();
    });
    socket.on("pong", () => {
      const binding = bindings.get(socket);
      if (binding) binding.lastSeen = now();
    });
    socket.on("close", () => {
      deadlines.delete(socket);
      const binding = bindings.get(socket);
      bindings.delete(socket);
      if (!binding) return;
      const { room, member, role } = binding;
      if (member.socket !== socket) return;
      member.socket = undefined;
      if (!rooms.has(room.id)) return;
      if (role === "camera") {
        gpu.ownerDisconnected(room.id);
        room.status = "offline";
        room.ownerDeadline = now() + limits.ownerGraceMs;
        broadcast(room, {
          v: 2,
          type: "source.unavailable",
          reason: "source_offline",
          graceExpiresAt: room.ownerDeadline,
        });
      } else {
        member.expiresAt = now() + limits.ownerGraceMs;
        for (const [id, pending] of room.requests)
          if (pending.viewerId === member.id) retireRequest(room, id);
        viewersChanged(room);
      }
    });
    socket.on("message", (raw: RawData, binary: boolean) => {
      try {
        const bytes = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : raw;
        const binding = bindings.get(socket);
        if (!binding) {
          if (
            binary ||
            bytes.length > limits.textBytes ||
            now() >= (deadlines.get(socket) ?? 0)
          )
            throw new Error("handshake");
          const hello = HelloSchema.parse(JSON.parse(bytes.toString("utf8")));
          maintain();
          const room = rooms.get(hello.roomId);
          if (!room) throw new Error("handshake");
          const member =
            hello.role === "camera"
              ? equalToken(hello.token, room.owner.digest)
                ? room.owner
                : undefined
              : [...room.viewers.values()].find((m) =>
                  equalToken(hello.token, m.digest),
                );
          if (
            !member ||
            (hello.role === "viewer" &&
              member.expiresAt <= now() &&
              !member.socket)
          )
            throw new Error("handshake");
          const previous = member.socket;
          if (previous && hello.role === "camera")
            gpu.ownerDisconnected(room.id);
          member.socket = socket;
          if (previous) disconnect(previous, 1000, "Connection replaced");
          bindings.set(socket, {
            room,
            member,
            role: hello.role,
            lastSeen: now(),
            controlStart: now(),
            controls: 0,
          });
          deadlines.delete(socket);
          if (hello.role === "camera") room.ownerDeadline = Infinity;
          else member.expiresAt = room.expiresAt;
          control(room, socket, {
            v: 2,
            type: "hello.ok",
            serverEpoch,
            /**
             * Analysis-frame header revision this relay validates. Absent on
             * relays deployed before the vehicle-intelligence pass, and a
             * camera that sees it absent omits the fields those relays would
             * reject. `FrameSchema` is strict and a rejected frame disconnects
             * the camera, so this keeps deployment order harmless in both
             * directions.
             */
            frameProtocol: 2,
            connectionId: member.id,
            role: hello.role,
            ...(hello.role === "viewer" ? { viewerId: member.id } : {}),
            roomExpiresAt: room.expiresAt,
            sourceStatus: room.status,
            viewerCount: viewerCount(room),
            ...budget(room),
          });
          viewersChanged(room);
          if (hello.role === "camera") recoverViewers(room);
          return;
        }
        const { room, role, member } = binding;
        if (
          !rooms.has(room.id) ||
          room.expiresAt <= now() ||
          member.socket !== socket ||
          (role === "viewer" && !room.viewers.has(member.id))
        )
          throw new Error("expired");
        binding.lastSeen = now();
        if (binary) {
          if (role !== "camera") throw new Error("role");
          const { header, jpeg } = decodePacket(bytes);
          if (jpeg.byteLength > limits.jpegBytes) throw new Error("size");
          if (header.type === "analysis.frame") {
            if (
              header.result.captureEpoch === room.epoch &&
              header.result.frameSeq <= room.frameSeq
            )
              return;
            if (now() - room.lastPreview < 1000 / limits.previewHz) return;
            room.epoch = header.result.captureEpoch;
            room.frameSeq = header.result.frameSeq;
            room.lastPreview = now();
            for (const viewer of room.viewers.values())
              send(room, viewer.socket, bytes, true);
            control(room, room.owner.socket, {
              v: 2,
              type: "sharing.budget",
              ...budget(room),
            });
          } else {
            const pending = correlated(
              room,
              header.requestId,
              "evidence.frame",
              header.evidenceId,
            );
            if (!pending) return;
            send(room, room.viewers.get(pending.viewerId)?.socket, bytes);
            retireRequest(room, header.requestId);
          }
          return;
        }
        if (bytes.length > limits.textBytes) throw new Error("size");
        if (now() - binding.controlStart >= 1000) {
          binding.controlStart = now();
          binding.controls = 0;
        }
        if (++binding.controls > 10) throw new Error("rate");
        const message = ControlSchema.parse(JSON.parse(bytes.toString("utf8")));
        if (message.type === "pong") return;
        if (message.type === "ping") {
          control(room, socket, { v: 2, type: "pong" });
          return;
        }
        if (role === "viewer") {
          if (
            !["state.request", "review.request", "evidence.request"].includes(
              message.type,
            ) ||
            !("requestId" in message) ||
            !message.requestId
          )
            throw new Error("role");
          if (
            !room.owner.socket ||
            room.owner.socket.readyState !== WebSocket.OPEN
          ) {
            control(
              room,
              socket,
              errorBody(
                "source_offline",
                "The camera is disconnected.",
                message.requestId,
              ),
            );
            return;
          }
          if (
            room.requests.has(message.requestId) ||
            room.retiredRequests.has(message.requestId) ||
            (message.type === "state.request" &&
              [...room.requests.values()].some(
                (pending) =>
                  pending.viewerId === member.id &&
                  pending.response === "state.snapshot",
              )) ||
            room.requests.size >= limits.requests
          ) {
            control(
              room,
              socket,
              errorBody(
                "invalid_request",
                "Too many or duplicate requests.",
                message.requestId,
              ),
            );
            return;
          }
          if (message.type === "state.request") {
            snapshotRequest(room, member.id, message.requestId);
            return;
          }
          room.requests.set(message.requestId, {
            viewerId: member.id,
            response:
              message.type === "review.request"
                ? "review.result"
                : "evidence.frame",
            expiresAt: now() + limits.requestMs,
            ...(message.type === "evidence.request"
              ? { evidenceId: message.evidenceId }
              : {}),
            batches: 0,
            reportCount: 0,
          });
          control(room, room.owner.socket, {
            ...message,
            requesterId: member.id,
          });
          return;
        }
        if (message.type === "camera.status") {
          room.status = message.state;
          broadcast(room, message);
          return;
        }
        if (
          message.type === "session.update" ||
          message.type === "report.upsert"
        ) {
          broadcast(room, message);
          return;
        }
        if (
          message.type === "state.snapshot" ||
          message.type === "review.result" ||
          message.type === "error"
        ) {
          if (
            !message.requestId ||
            (message.type === "error" &&
              message.code !== "evidence_unavailable")
          )
            throw new Error("correlation");
          const pending = correlated(
            room,
            message.requestId,
            message.type === "error" ? "evidence.frame" : message.type,
            message.type === "error"
              ? (room.requests.get(message.requestId)?.evidenceId ??
                  room.retiredRequests.get(message.requestId)?.evidenceId)
              : undefined,
          );
          if (!pending) {
            if (message.type === "state.snapshot" && message.done)
              finishSnapshot(room, message.requestId);
            return;
          }
          if (
            ++pending.batches >
            Math.ceil(limits.reports / limits.snapshotReports) + 1
          )
            throw new Error("batches");
          if (message.type === "state.snapshot") {
            pending.reportCount += message.reports.length;
            if (pending.reportCount > limits.reports)
              throw new Error("reports");
          }
          control(room, room.viewers.get(pending.viewerId)?.socket, message);
          if (message.type !== "state.snapshot" || message.done)
            retireRequest(room, message.requestId);
          if (message.type === "state.snapshot" && message.done)
            finishSnapshot(room, message.requestId);
          return;
        }
        throw new Error("role");
      } catch {
        const binding = bindings.get(socket);
        if (binding)
          control(
            binding.room,
            socket,
            errorBody(
              "invalid_request",
              "Invalid message or session authority.",
            ),
          );
        disconnect(socket);
      }
    });
  });
  function maintain() {
    gpu.maintain();
    const time = now();
    for (const [socket, deadline] of deadlines)
      if (time >= deadline) {
        deadlines.delete(socket);
        disconnect(socket);
      }
    for (const room of [...rooms.values()]) {
      if (time >= room.expiresAt || time >= room.ownerDeadline) {
        endRoom(
          room,
          time >= room.expiresAt ? "room_expired" : "source_offline",
        );
        continue;
      }
      if (time >= room.codeExpiresAt) codes.delete(room.code);
      for (const [id, viewer] of room.viewers)
        if (!viewer.socket && time >= viewer.expiresAt) room.viewers.delete(id);
      for (const [id, pending] of room.requests)
        if (time >= pending.expiresAt) {
          control(
            room,
            room.viewers.get(pending.viewerId)?.socket,
            errorBody("source_offline", "Source response timed out.", id),
          );
          retireRequest(room, id);
        }
      for (const [id, retired] of room.retiredRequests)
        if (time >= retired.expiresAt) room.retiredRequests.delete(id);
      if (room.snapshotActive && time >= room.snapshotActive.expiresAt)
        room.snapshotActive = undefined;
      dispatchSnapshot(room);
    }
    for (const [socket, binding] of bindings)
      if (time - binding.lastSeen >= limits.staleMs) socket.terminate();
    for (const [key, entry] of rates)
      if (time - entry.start >= 60_000) rates.delete(key);
  }
  const cleanup = setInterval(
    maintain,
    Math.min(1000, limits.helloMs, limits.reservationMs, limits.ownerGraceMs),
  );
  cleanup.unref();
  const heartbeat = setInterval(() => {
    for (const socket of bindings.keys())
      if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, limits.heartbeatMs);
  heartbeat.unref();
  return {
    app,
    server,
    wss,
    gpuWss: gpu.wss,
    serverEpoch,
    maintain,
    stats: () => ({
      rooms: rooms.size,
      codes: codes.size,
      sockets: wss.clients.size,
      rates: rates.size,
      pendingRequests: [...rooms.values()].reduce(
        (sum, room) => sum + room.requests.size,
        0,
      ),
      retiredRequests: [...rooms.values()].reduce(
        (sum, room) => sum + room.retiredRequests.size,
        0,
      ),
      bootBytes,
      gpu: gpu.stats(),
    }),
    close: async () => {
      closed = true;
      clearInterval(cleanup);
      clearInterval(heartbeat);
      for (const room of [...rooms.values()]) endRoom(room, "relay_shutdown");
      await gpu.close();
      for (const socket of wss.clients) socket.terminate();
      rates.clear();
      deadlines.clear();
      bindings.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
