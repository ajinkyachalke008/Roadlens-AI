import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket, type RawData } from "ws";
import { createRelay, type RelayConfig } from "../../backend/src/relay.js";
import { decodePacket, encodePacket } from "../../shared/src/packets.js";
import { emptyCounts, type FrameResult } from "../../shared/src/schemas.js";
import { report as syntheticReport, markerJpeg } from "../contracts/fixtures";

const origin = "http://localhost:5173";
const resources: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});
const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check: () => boolean, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await delay(10);
  }
}
type Json = Record<string, unknown>;
class Client {
  socket: WebSocket;
  messages: Json[] = [];
  binaries: Buffer[] = [];
  ended = false;
  constructor(url: string, requestedOrigin = origin) {
    this.socket = new WebSocket(url, { origin: requestedOrigin });
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
    resources.push(() => {
      this.socket.terminate();
    });
  }
  async open() {
    await eventually(
      () => this.socket.readyState === WebSocket.OPEN || this.ended,
    );
    return this;
  }
  send(value: unknown) {
    this.socket.send(JSON.stringify(value));
  }
  async message(type: string) {
    await eventually(() => this.messages.some((m) => m.type === type));
    return this.messages.splice(
      this.messages.findIndex((m) => m.type === type),
      1,
    )[0];
  }
  async hello(roomId: string, token: string, role = "camera") {
    this.send({ v: 2, type: "hello", roomId, token, role });
    return this.message("hello.ok");
  }
}
async function fixture(options: Partial<RelayConfig> = {}) {
  let clock = Date.now();
  const relay = createRelay({
    origins: [origin],
    now: () => clock,
    ...options,
  });
  await new Promise<void>((resolve) =>
    relay.server.listen(0, "127.0.0.1", resolve),
  );
  resources.push(() => relay.close());
  const address = relay.server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (
    path: string,
    body?: unknown,
    token?: string,
    method = "POST",
    requestOrigin = origin,
  ) =>
    fetch(base + path, {
      method,
      headers: {
        Origin: requestOrigin,
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const create = async () => {
    const response = await request("/api/rooms", { v: 2, name: "Test camera" });
    expect(response.status).toBe(201);
    return (await response.json()) as {
      roomId: string;
      ownerToken: string;
      pairingCode: string;
    };
  };
  const join = async (code: string) => {
    const response = await request("/api/join", { v: 2, code });
    expect(response.status).toBe(200);
    return (await response.json()) as { viewerId: string; viewerToken: string };
  };
  const connect = () => new Client(base.replace("http:", "ws:") + "/ws").open();
  const pair = async () => {
    const room = await create();
    const owner = await connect();
    await owner.hello(room.roomId, room.ownerToken);
    const viewer = await join(room.pairingCode);
    const client = await connect();
    await client.hello(room.roomId, viewer.viewerToken, "viewer");
    return { room, owner, viewer, client };
  };
  return {
    relay,
    base,
    request,
    create,
    join,
    connect,
    pair,
    advance: (ms: number) => {
      clock += ms;
      relay.maintain();
    },
  };
}
// Minimal JPEG markers deliberately exercise framing only; actual image/model E2E is separate.
function packet(
  seq = 1,
  epoch = "b6ac502f-4554-4b57-8802-1b5e98db4678",
  extra: Partial<FrameResult> = {},
) {
  const frameId = `${epoch}:${seq}`;
  const result: FrameResult = {
    v: 2,
    frameId,
    sourceId: "a6ac502f-4554-4b57-8802-1b5e98db4678",
    captureEpoch: epoch,
    frameSeq: seq,
    sourceMode: "synthetic_test",
    sourceTimeMs: seq * 1000,
    capturedAtIso: new Date(0).toISOString(),
    frameWidth: 640,
    frameHeight: 480,
    modelId: "contract-test",
    modelSha256: "0".repeat(64),
    detectorProfile: "416",
    executionProvider: "wasm",
    trackerVersion: "test",
    calibrationVersion: null,
    policyVersion: "test",
    inferenceMs: 10,
    analysisHz: 1,
    tracks: [],
    stats: { counts: emptyCounts(), validSpeedCount: 0, averageSpeedMps: null },
    ...extra,
  };
  return encodePacket(
    {
      v: 2,
      type: "analysis.frame",
      frameId,
      imageWidth: 640,
      imageHeight: 480,
      imageLength: 4,
      result,
    },
    new Uint8Array([255, 216, 255, 217]),
  );
}

describe("B10/B11/B44 RAM relay protocol", () => {
  it("accepts the strict browser config POST without weakening Origin checks", async () => {
    const f = await fixture({ limits: { rooms: 2 } });
    const response = await f.request("/api/config", { v: 2 });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const config = await response.json();
    expect(config.limits.rooms).toBe(2);
    expect(config.gpu).toEqual({ enabled: false, state: "offline" });
    const get = await f.request("/api/config", undefined, undefined, "GET");
    expect(await get.json()).toEqual(config);
    for (const body of [{}, { v: 1 }, { v: 2, secret: "no" }]) {
      expect((await f.request("/api/config", body)).status).toBe(400);
    }
    expect(
      (
        await f.request(
          "/api/config",
          { v: 2 },
          undefined,
          "POST",
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(f.base + "/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ v: 2 }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(f.base + "/api/config", {
          method: "POST",
          headers: { Origin: origin },
          body: JSON.stringify({ v: 2 }),
        })
      ).status,
    ).toBe(415);
  });
  it("advertises the effective lower configured limits", async () => {
    const f = await fixture({
      limits: { jpegBytes: 32768, rooms: 2, roomBytes: 1048576 },
    });
    const response = await f.request(
      "/api/config",
      undefined,
      undefined,
      "GET",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).limits).toMatchObject({
      jpegBytes: 32768,
      rooms: 2,
      roomBytes: 1048576,
      viewers: 2,
    });
  });
  it("creates secret no-store responses, formatted codes and minimal health", async () => {
    const f = await fixture();
    const response = await f.request("/api/rooms", { v: 2, name: "Cam" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const room = await response.json();
    expect(room.pairingCode).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    expect(room.ownerToken).toHaveLength(43);
    const health = await (await fetch(f.base + "/healthz")).json();
    expect(Object.keys(health).sort()).toEqual(["healthy", "serverEpoch", "v"]);
    expect(
      (await f.request("/api/rooms", { v: 2, name: "x", extra: true })).status,
    ).toBe(400);
  });
  it("rejects origin, wrong codes, confusable characters, missing origin and content types", async () => {
    const f = await fixture();
    expect(
      (
        await f.request(
          "/api/rooms",
          { v: 2, name: "x" },
          undefined,
          "POST",
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    expect((await fetch(f.base + "/api/config")).status).toBe(403);
    expect(
      (
        await fetch(f.base + "/api/rooms", {
          method: "POST",
          headers: { Origin: origin },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (await f.request("/api/join", { v: 2, code: "OOOO-OOOO" })).status,
    ).toBe(404);
    const bad = new Client(
      f.base.replace("http:", "ws:") + "/ws",
      "https://evil.example",
    );
    await eventually(() => bad.ended);
  });
  it("caps rooms, viewer reservations and releases unconnected reservations", async () => {
    const f = await fixture({ limits: { rooms: 1 } });
    const room = await f.create();
    const owner = await f.connect();
    await owner.hello(room.roomId, room.ownerToken);
    expect(
      (await f.request("/api/rooms", { v: 2, name: "another" })).status,
    ).toBe(503);
    await f.join(room.pairingCode.toLowerCase().replace("-", " "));
    await f.join(room.pairingCode);
    expect(
      (await f.request("/api/join", { v: 2, code: room.pairingCode })).status,
    ).toBe(404);
    f.advance(20_001);
    await f.join(room.pairingCode);
  });
  it("rejects wrong capability, role misuse and frames before hello", async () => {
    const f = await fixture();
    const { room, viewer } = await f.pair();
    for (const [token, role] of [
      [viewer.viewerToken, "camera"],
      [room.ownerToken, "viewer"],
      ["x".repeat(43), "camera"],
    ]) {
      const socket = await f.connect();
      socket.send({ v: 2, type: "hello", roomId: room.roomId, token, role });
      await eventually(() => socket.ended);
    }
    const socket = await f.connect();
    socket.socket.send(packet());
    await eventually(() => socket.ended);
  });
  it("enforces first handshake deadline and initial owner deadline", async () => {
    const f = await fixture();
    const room = await f.create();
    const socket = await f.connect();
    f.advance(5001);
    await eventually(() => socket.ended);
    f.advance(15_000);
    expect(f.relay.stats().rooms).toBe(0);
    expect(
      (await f.request("/api/join", { v: 2, code: room.pairingCode })).status,
    ).toBe(404);
  });
  it("rotates invitations while keeping paired viewers then revokes all viewer tokens", async () => {
    const f = await fixture();
    const { room, owner, client, viewer } = await f.pair();
    expect(
      (
        await f.request(
          `/api/rooms/${room.roomId}/code`,
          {},
          viewer.viewerToken,
        )
      ).status,
    ).toBe(403);
    const rotated = await (
      await f.request(
        `/api/rooms/${room.roomId}/code`,
        { v: 2 },
        room.ownerToken,
      )
    ).json();
    expect(rotated.pairingCode).not.toBe(room.pairingCode);
    expect(
      (await f.request("/api/join", { v: 2, code: room.pairingCode })).status,
    ).toBe(404);
    expect(client.ended).toBe(false);
    await f.request(
      `/api/rooms/${room.roomId}/revoke-viewers`,
      { v: 2 },
      room.ownerToken,
    );
    expect((await client.message("room.ended")).reason).toBe("revoked");
    await eventually(() => client.ended);
    const retry = await f.connect();
    retry.send({
      v: 2,
      type: "hello",
      roomId: room.roomId,
      role: "viewer",
      token: viewer.viewerToken,
    });
    await eventually(() => retry.ended);
    expect(owner.ended).toBe(false);
  });
  it("expires invitation independently of live room and hard-expires the room", async () => {
    const f = await fixture({ limits: { staleMs: 9_000_000 } });
    const { room, client } = await f.pair();
    f.advance(600_001);
    expect(
      (await f.request("/api/join", { v: 2, code: room.pairingCode })).status,
    ).toBe(404);
    expect(client.ended).toBe(false);
    f.advance(3_000_000);
    expect((await client.message("room.ended")).reason).toBe("room_expired");
    expect(f.relay.stats().rooms).toBe(0);
  });
  it("isolates two rooms and targets snapshot/review/evidence correlations", async () => {
    const f = await fixture();
    const first = await f.pair();
    const second = await f.pair();
    const extra = await f.join(first.room.pairingCode);
    const otherViewer = await f.connect();
    await otherViewer.hello(first.room.roomId, extra.viewerToken, "viewer");
    const requestId = randomUUID();
    first.client.send({ v: 2, type: "state.request", requestId });
    const forwarded = await first.owner.message("state.request");
    expect(forwarded.requesterId).toBe(first.viewer.viewerId);
    first.owner.send({
      v: 2,
      type: "state.snapshot",
      requestId,
      reports: [],
      done: false,
    });
    expect((await first.client.message("state.snapshot")).done).toBe(false);
    first.owner.send({
      v: 2,
      type: "state.snapshot",
      requestId,
      reports: [],
      done: true,
    });
    await first.client.message("state.snapshot");
    const reviewId = randomUUID();
    first.client.send({
      v: 2,
      type: "review.request",
      requestId: reviewId,
      reportId: randomUUID(),
      expectedRevision: 1,
      review: "noted",
    });
    await first.owner.message("review.request");
    first.owner.send({
      v: 2,
      type: "review.result",
      requestId: reviewId,
      accepted: false,
      code: "report_unavailable",
    });
    await first.client.message("review.result");
    const evidenceId = randomUUID(),
      evidenceRequest = randomUUID();
    first.client.send({
      v: 2,
      type: "evidence.request",
      requestId: evidenceRequest,
      evidenceId,
    });
    await first.owner.message("evidence.request");
    first.owner.socket.send(
      encodePacket(
        {
          v: 2,
          type: "evidence.frame",
          requestId: evidenceRequest,
          evidenceId,
          imageLength: 4,
          imageWidth: 1,
          imageHeight: 1,
        },
        new Uint8Array([255, 216, 255, 217]),
      ),
    );
    await eventually(() => first.client.binaries.length === 1);
    expect(otherViewer.binaries).toHaveLength(0);
    expect(second.client.binaries).toHaveLength(0);
    expect(otherViewer.messages.some((m) => m.type === "state.snapshot")).toBe(
      false,
    );
    expect(f.relay.stats().pendingRequests).toBe(0);
  });
  it("rejects forged requester identities and cross-room response IDs", async () => {
    const f = await fixture();
    const a = await f.pair();
    const b = await f.pair();
    const id = randomUUID();
    a.client.send({ v: 2, type: "state.request", requestId: id });
    await a.owner.message("state.request");
    b.owner.send({
      v: 2,
      type: "state.snapshot",
      requestId: id,
      reports: [],
      done: true,
    });
    await eventually(() => b.owner.ended);
    a.client.send({
      v: 2,
      type: "state.request",
      requestId: randomUUID(),
      requesterId: b.viewer.viewerId,
    });
    await eventually(() => a.client.ended);
  });
  it("routes correlated evidence unavailable and expires bounded pending requests", async () => {
    const f = await fixture({ limits: { requests: 1 } });
    const { client, owner } = await f.pair();
    const id = randomUUID();
    client.send({
      v: 2,
      type: "evidence.request",
      requestId: id,
      evidenceId: randomUUID(),
    });
    await owner.message("evidence.request");
    client.send({ v: 2, type: "state.request", requestId: randomUUID() });
    expect((await client.message("error")).code).toBe("invalid_request");
    owner.send({
      v: 2,
      type: "error",
      requestId: id,
      code: "evidence_unavailable",
      message: "Evidence was evicted.",
    });
    expect((await client.message("error")).code).toBe("evidence_unavailable");
    client.send({ v: 2, type: "state.request", requestId: randomUUID() });
    await owner.message("state.request");
    f.advance(10_001);
    expect((await client.message("error")).code).toBe("source_offline");
    expect(f.relay.stats().pendingRequests).toBe(0);
  });
  it("replaces the same capability socket without marking owner offline", async () => {
    const f = await fixture();
    const { room, owner, client } = await f.pair();
    const replacement = await f.connect();
    await replacement.hello(room.roomId, room.ownerToken);
    await eventually(() => owner.ended);
    expect(client.messages.some((m) => m.type === "source.unavailable")).toBe(
      false,
    );
    expect(replacement.ended).toBe(false);
  });
  it("broadcasts owner loss, permits grace reconnect then clears views after deadline", async () => {
    const f = await fixture();
    const { room, owner, client } = await f.pair();
    owner.socket.terminate();
    await client.message("source.unavailable");
    const replacement = await f.connect();
    await replacement.hello(room.roomId, room.ownerToken);
    replacement.socket.terminate();
    await client.message("source.unavailable");
    f.advance(45_001);
    expect((await client.message("room.ended")).reason).toBe("source_offline");
    expect(f.relay.stats().rooms).toBe(0);
  });
  it("forwards atomic packets, drops duplicate/out-of-order/rate-excess previews", async () => {
    const f = await fixture();
    const { owner, client } = await f.pair();
    owner.socket.send(packet(2));
    await eventually(() => client.binaries.length === 1);
    owner.socket.send(packet(3));
    await delay();
    expect(client.binaries).toHaveLength(1);
    f.advance(501);
    owner.socket.send(packet(1));
    owner.socket.send(packet(2));
    await delay();
    expect(client.binaries).toHaveLength(1);
    owner.socket.send(packet(3));
    await eventually(() => client.binaries.length === 2);
    expect(client.binaries[1]).toEqual(Buffer.from(packet(3)));
  });
  it("rejects viewer frame publication, malformed envelopes and oversized messages", async () => {
    const f = await fixture();
    const first = await f.pair();
    first.client.socket.send(packet());
    await eventually(() => first.client.ended);
    first.owner.socket.send(Buffer.from("RLN2malformed"));
    await eventually(() => first.owner.ended);
    const second = await f.pair();
    second.owner.socket.send(Buffer.alloc(193 * 1024));
    await eventually(() => second.owner.ended);
  });
  it("accounts for real fanout and stops sharing visibly on room budget", async () => {
    const f = await fixture({ limits: { roomBytes: 2400 } });
    const { owner, client } = await f.pair();
    owner.socket.send(packet());
    await eventually(() => client.binaries.length === 1);
    f.advance(501);
    owner.socket.send(packet(2));
    expect((await client.message("room.ended")).reason).toBe(
      "sharing_budget_exhausted",
    );
    expect(f.relay.stats().bootBytes).toBeLessThanOrEqual(2400);
    expect(f.relay.stats().rooms).toBe(0);
  });
  it("does not retain a latest frame for late joins and sends nothing to absent viewers", async () => {
    const f = await fixture();
    const room = await f.create();
    const owner = await f.connect();
    await owner.hello(room.roomId, room.ownerToken);
    const before = f.relay.stats().bootBytes;
    owner.socket.send(packet());
    await owner.message("sharing.budget");
    expect(f.relay.stats().bootBytes - before).toBeLessThan(250);
    const viewer = await f.join(room.pairingCode);
    const client = await f.connect();
    await client.hello(room.roomId, viewer.viewerToken, "viewer");
    await delay();
    expect(client.binaries).toHaveLength(0);
  });
  it("drops a slow viewer preview independently and disconnects reliable overflow", async () => {
    const f = await fixture();
    const { room, owner, client } = await f.pair();
    const other = await f.join(room.pairingCode);
    const fast = await f.connect();
    await fast.hello(room.roomId, other.viewerToken, "viewer");
    // Deterministic transport pressure injection on a real accepted ws socket.
    const slowServerSocket = [...f.relay.wss.clients][1];
    Object.defineProperty(slowServerSocket, "bufferedAmount", {
      configurable: true,
      get: () => 300 * 1024,
    });
    owner.socket.send(packet());
    await eventually(() => fast.binaries.length === 1);
    expect(client.binaries).toHaveLength(0);
    owner.send({
      v: 2,
      type: "camera.status",
      state: "paused",
      captureEpoch: null,
      sourceMode: "live_camera",
      analysisHz: 0,
    });
    await eventually(() => client.ended);
    expect((await fast.message("camera.status")).state).toBe("paused");
  });
  it("applies IP limits without trusting forged forwarded addresses", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) await f.create();
    const response = await fetch(f.base + "/api/rooms", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.42",
      },
      body: JSON.stringify({ v: 2, name: "fourth" }),
    });
    expect(response.status).toBe(429);
    expect((await response.json()).retryAfterMs).toBe(60_000);
    expect(f.relay.stats().rates).toBeLessThanOrEqual(2048);
  });
  it("closes room through owner DELETE with no surviving invitations", async () => {
    const f = await fixture();
    const { room, client } = await f.pair();
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
    expect((await client.message("room.ended")).reason).toBe("owner_ended");
    expect(f.relay.stats().rooms).toBe(0);
    expect(f.relay.stats().codes).toBe(0);
  });
  it("rejects oversized text and image/frame identifier mismatch", async () => {
    const f = await fixture();
    const first = await f.pair();
    first.owner.socket.send(" ".repeat(32 * 1024 + 1));
    await eventually(() => first.owner.ended);
    const second = await f.pair();
    const bytes = packet();
    const headerLength = new DataView(bytes.buffer).getUint32(4);
    const header = JSON.parse(
      new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)),
    );
    header.frameId = header.frameId.slice(0, -1) + "2";
    const replacement = new TextEncoder().encode(JSON.stringify(header));
    bytes.set(replacement, 8);
    second.owner.socket.send(bytes);
    await eventually(() => second.owner.ended);
    expect(second.client.binaries).toHaveLength(0);
  });
  it("rejects viewer policy edits, excessive control messages and arbitrary owner HTTP fields", async () => {
    const f = await fixture();
    const first = await f.pair();
    expect(
      (
        await f.request(
          `/api/rooms/${first.room.roomId}/code`,
          { unexpected: true },
          first.room.ownerToken,
        )
      ).status,
    ).toBe(400);
    first.client.send({
      v: 2,
      type: "camera.status",
      state: "live",
      captureEpoch: null,
      sourceMode: "live_camera",
      analysisHz: 5,
    });
    await eventually(() => first.client.ended);
    for (let i = 0; i < 11; i++) first.owner.send({ v: 2, type: "ping" });
    await eventually(() => first.owner.ended);
  });
  it("stale heartbeat deadline disconnects an unresponsive source", async () => {
    const f = await fixture();
    const { client } = await f.pair();
    f.advance(45_001);
    await eventually(() => client.ended);
  });
  it("process byte exhaustion ends every active room", async () => {
    const f = await fixture({ limits: { processBytes: 3300 } });
    const first = await f.pair();
    const second = await f.pair();
    first.owner.socket.send(packet());
    await eventually(() => first.client.binaries.length === 1);
    second.owner.socket.send(packet());
    expect((await first.client.message("room.ended")).reason).toBe(
      "sharing_budget_exhausted",
    );
    expect((await second.client.message("room.ended")).reason).toBe(
      "sharing_budget_exhausted",
    );
    expect(f.relay.stats().rooms).toBe(0);
    expect(f.relay.stats().bootBytes).toBeLessThanOrEqual(3300);
  });
  it("synchronises plate fields to viewers without disturbing plate-free reports", async () => {
    const f = await fixture();
    const { owner, client } = await f.pair();
    // A report from a camera that never ran plate recognition must reach the
    // viewer byte for byte as a build without the feature would have sent it.
    const legacy = syntheticReport(1);
    owner.send({ v: 2, type: "report.upsert", report: legacy });
    const received = await client.message("report.upsert");
    expect(received.report).toEqual(legacy);
    expect(Object.keys(received.report as object)).not.toContain("plateStatus");
    // A settled reading travels intact, including the frames that agreed.
    const read = {
      ...syntheticReport(2),
      plateStatus: "read" as const,
      plateText: "ABC1234",
      plateConfidence: 0.91,
      plateSupportingFrames: 3,
      plateDetectorConfidence: 0.82,
    };
    owner.send({ v: 2, type: "report.upsert", report: read });
    expect((await client.message("report.upsert")).report).toEqual(read);
    // So does a revision that later downgrades the same report to unreadable.
    const downgraded = {
      ...read,
      revision: 1,
      plateStatus: "unreadable" as const,
      plateText: null,
      plateConfidence: null,
      plateDetectorConfidence: 0.4,
    };
    owner.send({ v: 2, type: "report.upsert", report: downgraded });
    expect((await client.message("report.upsert")).report).toEqual(downgraded);
  });
  it("refuses a report claiming a plate no frames agreed on", async () => {
    const f = await fixture();
    const { owner, client } = await f.pair();
    owner.send({
      v: 2,
      type: "report.upsert",
      report: {
        ...syntheticReport(3),
        plateStatus: "read",
        plateText: "ABC1234",
        plateConfidence: 0.99,
        plateSupportingFrames: 1,
        plateDetectorConfidence: 0.9,
      },
    });
    await eventually(() => owner.ended);
    expect(
      client.messages.some((message) => message.type === "report.upsert"),
    ).toBe(false);
  });
  it("reports source-offline requests and limits exact cross-room capabilities", async () => {
    const f = await fixture();
    const a = await f.pair();
    const b = await f.pair();
    a.owner.socket.terminate();
    await a.client.message("source.unavailable");
    a.client.send({ v: 2, type: "state.request", requestId: randomUUID() });
    expect((await a.client.message("error")).code).toBe("source_offline");
    const bad = await f.connect();
    bad.send({
      v: 2,
      type: "hello",
      roomId: b.room.roomId,
      token: a.viewer.viewerToken,
      role: "viewer",
    });
    await eventually(() => bad.ended);
  });
});

describe("Release: canceled correlations and source-owned reconnect recovery", () => {
  it("a viewer disconnect cannot close the owner with an in-flight snapshot; another viewer still syncs", async () => {
    const f = await fixture();
    const first = await f.pair();
    const secondCapability = await f.join(first.room.pairingCode);
    const second = await f.connect();
    await second.hello(
      first.room.roomId,
      secondCapability.viewerToken,
      "viewer",
    );
    const firstId = randomUUID(),
      secondId = randomUUID();
    first.client.send({ v: 2, type: "state.request", requestId: firstId });
    await first.owner.message("state.request");
    second.send({ v: 2, type: "state.request", requestId: secondId });
    await eventually(() => f.relay.stats().pendingRequests === 2);
    first.owner.messages.length = 0;
    first.client.socket.terminate();
    await eventually(() =>
      first.owner.messages.some(
        (message) =>
          message.type === "viewers.changed" && message.viewerCount === 1,
      ),
    );
    first.owner.send({
      v: 2,
      type: "state.snapshot",
      requestId: firstId,
      reports: [syntheticReport(1)],
      done: false,
    });
    first.owner.send({
      v: 2,
      type: "state.snapshot",
      requestId: firstId,
      reports: [],
      done: true,
    });
    const next = await first.owner.message("state.request");
    expect(next.requestId).toBe(secondId);
    expect(next.requesterId).toBe(secondCapability.viewerId);
    first.owner.send({
      v: 2,
      type: "state.snapshot",
      requestId: secondId,
      reports: [syntheticReport(2)],
      done: true,
    });
    expect((await second.message("state.snapshot")).reports).toEqual([
      syntheticReport(2),
    ]);
    expect(first.owner.ended).toBe(false);
    expect(
      first.owner.messages.some((message) => message.type === "error"),
    ).toBe(false);
  });
  it("known expired snapshot batches are dropped without closing the source", async () => {
    const f = await fixture();
    const { owner, client } = await f.pair();
    const requestId = randomUUID();
    client.send({ v: 2, type: "state.request", requestId });
    await owner.message("state.request");
    f.advance(10_001);
    expect((await client.message("error")).code).toBe("source_offline");
    owner.send({
      v: 2,
      type: "state.snapshot",
      requestId,
      reports: [syntheticReport()],
      done: false,
    });
    owner.send({
      v: 2,
      type: "state.snapshot",
      requestId,
      reports: [],
      done: true,
    });
    owner.send({ v: 2, type: "ping" });
    await owner.message("pong");
    expect(owner.ended).toBe(false);
    expect(
      client.messages.some((message) => message.type === "state.snapshot"),
    ).toBe(false);
  });
  it("revocation tolerates already-in-flight evidence and evidence-unavailable replies", async () => {
    const f = await fixture();
    const { room, owner, client } = await f.pair();
    const requestId = randomUUID(),
      evidenceId = randomUUID();
    client.send({ v: 2, type: "evidence.request", requestId, evidenceId });
    await owner.message("evidence.request");
    await f.request(
      `/api/rooms/${room.roomId}/revoke-viewers`,
      { v: 2 },
      room.ownerToken,
    );
    await eventually(() => client.ended);
    owner.socket.send(
      encodePacket(
        {
          v: 2,
          type: "evidence.frame",
          requestId,
          evidenceId,
          imageWidth: 1,
          imageHeight: 1,
          imageLength: 4,
        },
        markerJpeg(),
      ),
    );
    owner.send({
      v: 2,
      type: "error",
      requestId,
      code: "evidence_unavailable",
      message: "Evidence unavailable",
    });
    owner.send({ v: 2, type: "ping" });
    await owner.message("pong");
    expect(owner.ended).toBe(false);
  });
  it("mismatched evidence IDs for an active request still reject the owner", async () => {
    const f = await fixture();
    const { owner, client } = await f.pair();
    const requestId = randomUUID();
    client.send({
      v: 2,
      type: "evidence.request",
      requestId,
      evidenceId: randomUUID(),
    });
    await owner.message("evidence.request");
    owner.socket.send(
      encodePacket(
        {
          v: 2,
          type: "evidence.frame",
          requestId,
          evidenceId: randomUUID(),
          imageWidth: 1,
          imageHeight: 1,
          imageLength: 4,
        },
        markerJpeg(),
      ),
    );
    await eventually(() => owner.ended);
    expect(client.binaries).toHaveLength(0);
  });
  it("source-only reconnect resynchronizes still-connected viewers from the camera, including missed revisions", async () => {
    const f = await fixture();
    const first = await f.pair();
    const other = await f.join(first.room.pairingCode);
    const second = await f.connect();
    await second.hello(first.room.roomId, other.viewerToken, "viewer");
    first.owner.send({
      v: 2,
      type: "report.upsert",
      report: syntheticReport(1),
    });
    await first.client.message("report.upsert");
    await second.message("report.upsert");
    first.owner.socket.terminate();
    await first.client.message("source.unavailable");
    await second.message("source.unavailable");
    const replacement = await f.connect();
    await replacement.hello(first.room.roomId, first.room.ownerToken);
    const missed = [
      { ...syntheticReport(1), revision: 1, review: "noted" },
      syntheticReport(2),
    ];
    const firstRequest = await replacement.message("state.request");
    expect(firstRequest.requesterId).toBe(first.viewer.viewerId);
    replacement.send({
      v: 2,
      type: "state.snapshot",
      requestId: firstRequest.requestId,
      reports: missed,
      done: true,
    });
    expect((await first.client.message("state.snapshot")).reports).toEqual(
      missed,
    );
    const secondRequest = await replacement.message("state.request");
    expect(secondRequest.requesterId).toBe(other.viewerId);
    replacement.send({
      v: 2,
      type: "state.snapshot",
      requestId: secondRequest.requestId,
      reports: missed,
      done: true,
    });
    expect((await second.message("state.snapshot")).reports).toEqual(missed);
    expect(first.client.ended).toBe(false);
    expect(second.ended).toBe(false);
    expect(replacement.ended).toBe(false);
    expect(f.relay.stats().pendingRequests).toBe(0);
  });
  it("two full 200-report snapshots serialize without overlapping camera work", async () => {
    const f = await fixture();
    const first = await f.pair();
    const other = await f.join(first.room.pairingCode);
    const second = await f.connect();
    await second.hello(first.room.roomId, other.viewerToken, "viewer");
    const ids = [randomUUID(), randomUUID()];
    first.client.send({ v: 2, type: "state.request", requestId: ids[0] });
    await first.owner.message("state.request");
    second.send({ v: 2, type: "state.request", requestId: ids[1] });
    await eventually(() => f.relay.stats().pendingRequests === 2);
    expect(
      first.owner.messages.filter(
        (message) => message.type === "state.request",
      ),
    ).toHaveLength(0);
    for (const [index, viewer] of [first.client, second].entries()) {
      let count = 0;
      if (index === 1)
        expect((await first.owner.message("state.request")).requestId).toBe(
          ids[1],
        );
      for (let batch = 0; batch < 20; batch++) {
        f.advance(150);
        first.owner.send({
          v: 2,
          type: "state.snapshot",
          requestId: ids[index],
          reports: Array.from({ length: 10 }, (_, offset) =>
            syntheticReport(batch * 10 + offset + 1),
          ),
          done: batch === 19,
        });
        count += ((await viewer.message("state.snapshot")).reports as unknown[])
          .length;
        if (index === 0 && batch < 19)
          expect(
            first.owner.messages.filter(
              (message) => message.type === "state.request",
            ),
          ).toHaveLength(0);
      }
      expect(count).toBe(200);
    }
    expect(first.owner.ended).toBe(false);
    expect(f.relay.stats().pendingRequests).toBe(0);
  });
  it("one viewer cannot enqueue duplicate snapshot work and retirement metadata stays bounded", async () => {
    const f = await fixture({ limits: { requestMs: 20 } });
    const { owner, client } = await f.pair();
    const firstId = randomUUID();
    client.send({ v: 2, type: "state.request", requestId: firstId });
    await owner.message("state.request");
    client.send({ v: 2, type: "state.request", requestId: randomUUID() });
    expect((await client.message("error")).code).toBe("invalid_request");
    f.advance(21);
    await client.message("error");
    for (let index = 0; index < 40; index++) {
      f.advance(1001);
      client.send({ v: 2, type: "state.request", requestId: randomUUID() });
      await owner.message("state.request");
      f.advance(21);
      await client.message("error");
    }
    expect(f.relay.stats().pendingRequests).toBe(0);
    expect(f.relay.stats().retiredRequests).toBeLessThanOrEqual(32);
  });
});

it("B45 actual child-process restart invalidates prior room capability and code", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill();
    await exited;
  }
  async function start() {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "backend/src/main.ts"],
      {
        cwd: process.cwd(),
        env: { ...process.env, PORT: String(port), ALLOWED_ORIGINS: origin },
        stdio: "ignore",
        windowsHide: true,
      },
    );
    resources.push(() => stop(child));
    let health: Json | undefined;
    const deadline = Date.now() + 10_000;
    while (!health) {
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error("Relay child did not start");
      try {
        health = await (await fetch(base + "/healthz")).json();
      } catch {
        await delay(50);
      }
    }
    return { child, health };
  }
  const first = await start();
  const created = await (
    await fetch(base + "/api/rooms", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ v: 2, name: "restart" }),
    })
  ).json();
  await stop(first.child);
  const second = await start();
  expect(second.health.serverEpoch).not.toBe(first.health.serverEpoch);
  expect(
    (
      await fetch(base + "/api/join", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ v: 2, code: created.pairingCode }),
      })
    ).status,
  ).toBe(404);
  const old = await new Client(base.replace("http:", "ws:") + "/ws").open();
  old.send({
    v: 2,
    type: "hello",
    roomId: created.roomId,
    token: created.ownerToken,
    role: "camera",
  });
  await eventually(() => old.ended);
}, 20_000);

/**
 * Analysis-frame header negotiation.
 *
 * `FrameSchema` is strict and a header this relay cannot parse disconnects the
 * camera, so the fields added by the vehicle-intelligence pass have to be
 * negotiated rather than assumed. The relay advertises what it accepts; the
 * camera omits the new fields when nothing was advertised.
 */
describe("Release: analysis-frame protocol negotiation", () => {
  it("advertises the frame protocol it validates", async () => {
    const f = await fixture();
    const room = await f.create();
    const owner = await f.connect();
    const ok = await owner.hello(room.roomId, room.ownerToken);
    expect(ok.frameProtocol).toBe(2);
    expect(ok.reportProtocol).toBe(2);
  });

  it("relays a frame carrying the new mode and selection fields", async () => {
    const f = await fixture();
    const { owner, client } = await f.pair();
    owner.socket.send(
      packet(1, "b6ac502f-4554-4b57-8802-1b5e98db4678", {
        mode: {
          operating: "mounted",
          speedActive: true,
          reason: "speed_active",
        },
        selectedTrackId: 12,
      }),
    );
    await eventually(() => client.binaries.length > 0);
    const { header } = decodePacket(client.binaries[0]!);
    if (header.type !== "analysis.frame") throw new Error("wrong packet");
    expect(header.result.mode).toEqual({
      operating: "mounted",
      speedActive: true,
      reason: "speed_active",
    });
    expect(header.result.selectedTrackId).toBe(12);
    expect(owner.ended).toBe(false);
  });

  it("still accepts a frame from a camera that omits them", async () => {
    const f = await fixture();
    const { owner, client } = await f.pair();
    owner.socket.send(packet(1));
    await eventually(() => client.binaries.length > 0);
    const { header } = decodePacket(client.binaries[0]!);
    if (header.type !== "analysis.frame") throw new Error("wrong packet");
    expect(header.result.mode).toBeUndefined();
    expect(header.result.selectedTrackId).toBeUndefined();
    expect(owner.ended).toBe(false);
  });
});
