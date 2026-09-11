import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoundedImageDecoder,
  DroppedImageError,
  jpegDimensions,
} from "../../frontend/src/transport/imageDecoder";
import {
  RelayClient,
  api,
  wakeRelay,
} from "../../frontend/src/transport/client";
import { LIMITS } from "../../shared/src/limits";
import { frame, uuid } from "../contracts/fixtures";
function jpeg(width = 640, height = 360) {
  return new Uint8Array([
    255,
    216,
    255,
    192,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    17,
    0,
    255,
    218,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    255,
    217,
  ]);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function bitmap(width = 640, height = 360) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("B42/B46 viewer decoded memory and lifecycle", () => {
  it("reads encoded JPEG dimensions before any browser pixel allocation", async () => {
    const create = vi.fn();
    const decoder = new BoundedImageDecoder(create);
    expect(jpegDimensions(jpeg())).toEqual({ width: 640, height: 360 });
    await expect(decoder.decode(jpeg(16000, 16000), 640, 360)).rejects.toThrow(
      "dimensions",
    );
    expect(create).not.toHaveBeenCalled();
  });
  it("rejects declared/encoded mismatches before decode", async () => {
    const create = vi.fn();
    await expect(
      new BoundedImageDecoder(create).decode(jpeg(), 320, 180),
    ).rejects.toThrow("metadata");
    expect(create).not.toHaveBeenCalled();
  });
  it("rejects malformed segments and files without a frame before SOS", () => {
    expect(() =>
      jpegDimensions(new Uint8Array([255, 216, 255, 218, 0, 2, 255, 217])),
    ).toThrow("no dimensions");
    const bytes = jpeg();
    bytes[5] = 255;
    expect(() => jpegDimensions(bytes)).toThrow("Truncated");
  });
  it("holds one active decode and only the newest pending preview/evidence job", async () => {
    const resolvers: ((image: ImageBitmap) => void)[] = [];
    const create = vi.fn(
      () => new Promise<ImageBitmap>((resolve) => resolvers.push(resolve)),
    );
    const decoder = new BoundedImageDecoder(create);
    const first = decoder.decode(jpeg(), 640, 360),
      second = decoder.decode(jpeg(), 640, 360).catch((e) => e),
      third = decoder.decode(jpeg(), 640, 360);
    await tick();
    expect(create).toHaveBeenCalledTimes(1);
    expect(await second).toBeInstanceOf(DroppedImageError);
    const a = bitmap();
    resolvers[0]!(a);
    expect(await first).toBe(a);
    await tick();
    expect(create).toHaveBeenCalledTimes(2);
    const b = bitmap();
    resolvers[1]!(b);
    expect(await third).toBe(b);
    a.close();
    b.close();
  });
  it("reset rejects pending work and closes late decoded pixels without resurrecting state", async () => {
    let finish!: (image: ImageBitmap) => void;
    const create = vi.fn(
      () => new Promise<ImageBitmap>((resolve) => (finish = resolve)),
    );
    const decoder = new BoundedImageDecoder(create);
    const old = decoder.decode(jpeg(), 640, 360).catch((e) => e);
    const pending = decoder.decode(jpeg(), 640, 360).catch((e) => e);
    await tick();
    decoder.reset();
    expect(await old).toBeInstanceOf(DroppedImageError);
    expect(await pending).toBeInstanceOf(DroppedImageError);
    const image = bitmap();
    finish(image);
    await tick();
    expect(image.close).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("decoded dimension mismatch closes the bitmap and rejects", async () => {
    const image = bitmap(320, 180);
    const decoder = new BoundedImageDecoder(async () => image);
    await expect(decoder.decode(jpeg(), 640, 360)).rejects.toThrow(
      "Decoded image dimensions",
    );
    expect(image.close).toHaveBeenCalledOnce();
  });
});
describe("B41 explicit free-relay wake and request cancellation (mocked HTTP)", () => {
  const health = () =>
    new Response(
      JSON.stringify({ healthy: true, v: 2, serverEpoch: "test-epoch" }),
      { headers: { "content-type": "application/json" } },
    );
  it("waits through a cold-start HTML response then sends exactly one room POST", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html>Starting</html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ roomId: "test-room" }), {
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const result = api("/api/rooms", { v: 2, name: "test" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ roomId: "test-room" });
    expect(fetcher.mock.calls.map((c) => c[1].method)).toEqual([
      "GET",
      "GET",
      "POST",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels health backoff without creating a room or leaving timers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    const fetcher = vi
      .fn()
      .mockImplementation(
        async () => new Response("Starting", { status: 503 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const result = api(
      "/api/join",
      { v: 2, code: "TEST-CODE" },
      undefined,
      "POST",
      controller.signal,
    ).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops a repeatedly unavailable relay at the 65-second overall deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    const fetcher = vi
      .fn()
      .mockImplementation(
        async () => new Response("Starting", { status: 503 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const result = wakeRelay().catch((error) => error);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(String(await result)).toContain("65 seconds");
    const calls = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(calls).toBeLessThan(15);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("never retries a failed room POST and never wakes for ordinary room updates", async () => {
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(api("/api/rooms", { v: 2, name: "test" })).rejects.toThrow(
      "Unavailable",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    await api("/api/rooms/test", undefined, "test-token", "DELETE");
    expect(fetcher.mock.calls.map((c) => c[1].method)).toEqual([
      "GET",
      "POST",
      "DELETE",
    ]);
  });
});
describe("B16 native socket outbound byte bounds", () => {
  it("does not enqueue an image if existing bytes plus complete envelope exceed cap", () => {
    vi.useFakeTimers();
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      bufferedAmount = LIMITS.bufferBytes - 10;
      binaryType = "";
      onopen: () => void = () => {};
      onmessage: (event: { data: string }) => void = () => {};
      onclose: () => void = () => {};
      onerror: () => void = () => {};
      send = vi.fn();
      close = vi.fn();
      static instance: FakeSocket;
      constructor() {
        FakeSocket.instance = this;
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    const client = new RelayClient(
      uuid(1),
      "camera",
      "ram-only-token",
      "server-epoch",
    );
    client.connect();
    const socket = FakeSocket.instance;
    socket.onmessage({
      data: JSON.stringify({
        v: 2,
        type: "hello.ok",
        serverEpoch: "server-epoch",
        viewerCount: 1,
      }),
    });
    const image = jpeg(),
      result = frame();
    const header = {
      v: 2 as const,
      type: "analysis.frame" as const,
      frameId: result.frameId,
      result,
      imageWidth: 640,
      imageHeight: 360,
      imageLength: image.length,
    };
    expect(client.sendPacket(header, image)).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
    socket.bufferedAmount = 0;
    expect(client.sendPacket(header, image)).toBe(true);
    expect(socket.send).toHaveBeenCalledOnce();
    client.close();
  });
});
describe("room handshake rejection and transient reconnection", () => {
  class FakeSocket {
    static OPEN = 1;
    static instances: FakeSocket[] = [];
    readyState = 1;
    binaryType = "";
    onopen = () => {};
    onmessage = (_event: { data: string }) => {};
    onclose = (_event: { code: number }) => {};
    onerror = () => {};
    send = vi.fn();
    close = vi.fn();
    constructor() {
      FakeSocket.instances.push(this);
    }
  }
  function connect() {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    const client = new RelayClient(
      uuid(1),
      "camera",
      "ram-only-token",
      "epoch",
    );
    const state = vi.fn();
    client.onState = state;
    client.connect();
    FakeSocket.instances[0]!.onopen();
    return { client, state, socket: FakeSocket.instances[0]! };
  }
  it("expires a rejected 1008 handshake immediately without retaining retry work", async () => {
    const { client, state, socket } = connect();
    socket.onclose({ code: 1008 });
    expect(state).toHaveBeenLastCalledWith(
      "Pairing expired — create a new code",
    );
    expect(client.connected).toBe(false);
    expect(client.viewerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    client.connect();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.send).toHaveBeenCalledOnce();
    client.close();
  });
  it.each([1006, 1013])(
    "retries transient close %i and permits a new handshake",
    async (code) => {
      const { client, state, socket } = connect();
      socket.onclose({ code });
      expect(state).toHaveBeenLastCalledWith("Source offline · reconnecting");
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(FakeSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.instances).toHaveLength(2);
      const replacement = FakeSocket.instances[1]!;
      replacement.onopen();
      expect(JSON.parse(replacement.send.mock.calls[0]![0])).toMatchObject({
        type: "hello",
        token: "ram-only-token",
      });
      replacement.onmessage({
        data: JSON.stringify({
          v: 2,
          type: "hello.ok",
          serverEpoch: "epoch",
          viewerCount: 0,
        }),
      });
      expect(client.connected).toBe(true);
      expect(state).toHaveBeenLastCalledWith("Connected");
      client.close();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
