import { LIMITS } from "../../../shared/src/limits";
import {
  ControlSchema,
  ReportSchema,
  type Control,
  type PacketHeader,
} from "../../../shared/src/schemas";
import { decodePacket, encodePacket } from "../../../shared/src/packets";
export interface Room {
  roomId: string;
  ownerToken: string;
  pairingCode: string;
  codeExpiresAt: number;
  roomExpiresAt: number;
  serverEpoch: string;
}
export interface Join {
  roomId: string;
  viewerId: string;
  viewerToken: string;
  roomExpiresAt: number;
  serverEpoch: string;
}
export type ServerMessage = Record<string, unknown>;
export const sharingAvailable = () =>
  import.meta.env.VITE_SHARING_DISABLED !== "true";
export function apiBase() {
  if (!sharingAvailable())
    throw new Error(
      "Sharing is unavailable on this deployment. Camera analysis and local reports are available.",
    );
  const raw = import.meta.env.VITE_API_BASE_URL?.trim();
  if (!raw) return location.origin;
  const url = new URL(raw);
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Invalid relay URL");
  if (
    url.protocol !== "https:" &&
    !(
      import.meta.env.DEV &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new Error("Relay requires HTTPS");
  return url.origin;
}
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
/** Only called for an explicit room creation/join. This never keeps an idle host awake. */
export async function wakeRelay(signal?: AbortSignal): Promise<void> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(new DOMException("Relay wake timed out", "TimeoutError")),
    65_000,
  );
  const active = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  const delays = [1000, 2000, 4000, 6000, 8000];
  let attempt = 0;
  try {
    for (;;) {
      active.throwIfAborted();
      try {
        const response = await fetch(apiBase() + "/healthz", {
          method: "GET",
          cache: "no-store",
          signal: AbortSignal.any([active, AbortSignal.timeout(10_000)]),
        });
        if (
          response.ok &&
          response.headers.get("content-type")?.includes("application/json")
        ) {
          const health = await response.json();
          active.throwIfAborted();
          if (
            health?.healthy === true &&
            health.v === 2 &&
            typeof health.serverEpoch === "string"
          )
            return;
        } else await response.body?.cancel();
      } catch {
        active.throwIfAborted();
      }
      await abortableDelay(
        delays[Math.min(attempt++, delays.length - 1)]!,
        active,
      );
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (deadline.signal.aborted)
      throw new Error(
        "Relay did not wake within 65 seconds. Try again shortly.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  token?: string,
  method = "POST",
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (method === "POST" && (path === "/api/rooms" || path === "/api/join"))
    await wakeRelay(signal);
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(25_000)])
    : AbortSignal.timeout(25_000);
  const res = await fetch(apiBase() + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: requestSignal,
  });
  if (res.status === 204) return undefined as T;
  if (!res.headers.get("content-type")?.includes("application/json"))
    throw new Error("Relay is waking or unavailable. Try again shortly.");
  const value = await res.json();
  if (!res.ok)
    throw new Error(
      typeof value.message === "string" ? value.message : "Pairing unavailable",
    );
  return value as T;
}
export class RelayClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private attempts = 0;
  private lastMessage = 0;
  private generation = 0;
  private queue: { text: string; bytes: number }[] = [];
  private queueBytes = 0;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  onMessage = (_message: ServerMessage) => {};
  onPacket = (_header: PacketHeader, _jpeg: Uint8Array) => {};
  onState = (_state: string) => {};
  viewerCount = 0;
  connected = false;
  constructor(
    private roomId: string,
    private role: "camera" | "viewer",
    private token: string,
    private serverEpoch: string,
  ) {}
  connect() {
    if (this.closed) return;
    const generation = ++this.generation;
    const url = new URL(apiBase());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    this.onState(this.attempts ? "Reconnecting" : "Connecting to relay");
    const ws = new WebSocket(url);
    this.socket = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (this.closed || generation !== this.generation) {
        ws.close();
        return;
      }
      ws.send(
        JSON.stringify({
          v: 2,
          type: "hello",
          roomId: this.roomId,
          role: this.role,
          token: this.token,
        }),
      );
    };
    ws.onmessage = (event) => {
      if (generation !== this.generation) return;
      this.lastMessage = performance.now();
      try {
        if (event.data instanceof ArrayBuffer) {
          const { header, jpeg } = decodePacket(new Uint8Array(event.data));
          this.onPacket(header, jpeg);
          return;
        }
        if (
          typeof event.data !== "string" ||
          event.data.length > LIMITS.textBytes
        )
          throw new Error("Invalid relay message");
        const m: ServerMessage = JSON.parse(event.data);
        if (m.v !== 2 || typeof m.type !== "string")
          throw new Error("Unsupported relay protocol");
        if (m.type === "hello.ok") {
          if (m.serverEpoch !== this.serverEpoch) {
            this.expire("Pairing expired — create a new code");
            return;
          }
          this.connected = true;
          this.attempts = 0;
          this.viewerCount = Number(m.viewerCount) || 0;
          this.onState("Connected");
          if (this.role === "viewer")
            this.send({
              v: 2,
              type: "state.request",
              requestId: crypto.randomUUID(),
            });
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.heartbeat = setInterval(() => {
            if (performance.now() - this.lastMessage > LIMITS.staleMs) {
              ws.close();
              return;
            }
            this.send({ v: 2, type: "ping" });
          }, LIMITS.heartbeatMs);
        } else if (m.type === "viewers.changed")
          this.viewerCount = Number(m.viewerCount) || 0;
        else if (m.type === "ping") {
          this.send({ v: 2, type: "pong" });
          return;
        } else if (m.type === "room.ended") {
          this.onMessage(m);
          this.expire("Sharing ended");
          return;
        } else if (m.type === "report.upsert") ReportSchema.parse(m.report);
        else if (m.type === "state.snapshot") ControlSchema.parse(m);
        this.onMessage(m);
      } catch {
        this.expire("Invalid relay message");
      }
    };
    ws.onclose = () => {
      if (generation !== this.generation) return;
      this.connected = false;
      this.viewerCount = 0;
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.closed) return;
      if (++this.attempts > 6) {
        this.expire("Pairing expired — create a new code");
        return;
      }
      this.onState("Source offline · reconnecting");
      this.reconnectTimer = setTimeout(
        () => this.connect(),
        Math.min(8000, 500 * 2 ** this.attempts),
      );
    };
    ws.onerror = () => this.onState("Relay unavailable");
  }
  send(message: Control) {
    if (
      !this.connected ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    )
      return false;
    const text = JSON.stringify(ControlSchema.parse(message));
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > LIMITS.textBytes) return false;
    if (
      this.queue.length >= 32 ||
      this.queueBytes + bytes > LIMITS.bufferBytes
    ) {
      this.socket.close();
      return false;
    }
    this.queue.push({ text, bytes });
    this.queueBytes += bytes;
    if (!this.drainTimer) this.drain();
    return true;
  }
  private drain() {
    this.drainTimer = null;
    if (
      !this.connected ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      this.queue = [];
      this.queueBytes = 0;
      return;
    }
    const item = this.queue.shift();
    if (!item) return;
    this.queueBytes -= item.bytes;
    if (this.socket.bufferedAmount + item.bytes > LIMITS.bufferBytes) {
      this.socket.close();
      this.queue = [];
      this.queueBytes = 0;
      return;
    }
    this.socket.send(item.text);
    this.drainTimer = setTimeout(() => this.drain(), 140);
  }
  sendPacket(header: PacketHeader, jpeg: Uint8Array) {
    if (
      !this.connected ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      (header.type === "analysis.frame" && this.viewerCount === 0)
    )
      return false;
    const packet = encodePacket(header, jpeg);
    if (this.socket.bufferedAmount + packet.byteLength > LIMITS.bufferBytes)
      return false;
    this.socket.send(packet.buffer as ArrayBuffer);
    return true;
  }
  private expire(reason: string) {
    this.close();
    this.onState(reason);
  }
  close() {
    this.closed = true;
    this.connected = false;
    this.viewerCount = 0;
    this.token = "";
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.queue = [];
    this.queueBytes = 0;
    this.socket?.close();
    this.socket = null;
  }
}
