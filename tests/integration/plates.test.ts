import { describe, expect, it } from "vitest";
import { PLATE_LIMITS } from "../../shared/src/limits.js";
import {
  fixture,
  frame,
  secret,
  plateDescriptor,
  plateRequest,
  until,
  type Json,
} from "./gpuFixture.js";

/**
 * Relay behaviour for the plate path, over the real transport.
 *
 * The point of every test here is the same: plate work is optional, bounded and
 * subordinate. It must correlate exactly, refuse rather than queue, and never be
 * able to damage the analysis path it shares a socket with.
 */
describe("Optional plate relay: bounded, correlated, subordinate", () => {
  it("advertises plate support only when the worker actually has it", async () => {
    const withPlate = await fixture();
    const a = await withPlate.ready(plateDescriptor);
    expect(a.camera.messages).toEqual([]);
    const plain = await fixture();
    const worker = await plain.register();
    const room = await plain.create();
    const camera = await plain.acquire(room);
    const status = await camera.message("gpu.status");
    expect(status.state).toBe("ready");
    expect(status.plate).toBeUndefined();
    expect(worker.ended).toBe(false);
  });
  it("tells the worker it understands plate messages before any are sent", async () => {
    // Without this the worker must stay silent: `worker.ready` is strict, so a
    // relay that predates plate support drops a worker that advertises one, and
    // the operator loses GPU analysis entirely rather than just plate reading.
    const f = await fixture();
    const worker = await f.connect("/worker");
    worker.send({
      v: 1,
      type: "worker.register",
      role: "worker",
      secret,
      workerVersion: "1",
    });
    expect(await worker.message("worker.registered")).toMatchObject({
      plateProtocol: 1,
    });
  });
  it("carries a status that names the loaded plate pipeline", async () => {
    const f = await fixture();
    const worker = await f.register(plateDescriptor);
    const room = await f.create();
    const camera = await f.acquire(room);
    expect((await camera.message("gpu.status")).plate).toEqual(plateDescriptor);
    expect(worker.ended).toBe(false);
  });
  it("forwards a vehicle crop and returns its reading to the camera", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready(plateDescriptor);
    const request = plateRequest(room.roomId);
    camera.socket.send(request.bytes);
    await until(() => worker.binaries.length === 1);
    expect(worker.binaries[0]!.subarray(0, 4).toString()).toBe("RLP1");
    expect(f.relay.stats().gpu.platePending).toBe(1);
    worker.send(request.result);
    const result = await camera.message("plate.result");
    expect(result).toMatchObject({
      requestId: request.header.requestId,
      trackId: request.header.trackId,
      plateText: "ABC1234",
    });
    expect(f.relay.stats().gpu.platePending).toBe(0);
  });
  it("refuses a plate request when the worker has no plate pipeline", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready();
    const request = plateRequest(room.roomId);
    camera.socket.send(request.bytes);
    const error = await camera.message("plate.error");
    expect(error).toMatchObject({
      requestId: request.header.requestId,
      code: "unavailable",
    });
    expect(worker.binaries).toHaveLength(0);
    expect(camera.ended).toBe(false);
  });
  it("keeps exactly one plate request in flight and refuses the rest", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready(plateDescriptor);
    const first = plateRequest(room.roomId, { frameSeq: 1 });
    camera.socket.send(first.bytes);
    await until(() => worker.binaries.length === 1);
    const extras = [2, 3, 4].map((frameSeq) =>
      plateRequest(room.roomId, { frameSeq }),
    );
    for (const extra of extras) camera.socket.send(extra.bytes);
    await until(
      () =>
        camera.messages.filter((message) => message.type === "plate.error")
          .length === extras.length,
    );
    expect(
      camera.messages
        .filter((message) => message.type === "plate.error")
        .every((message) => message.code === "busy"),
    ).toBe(true);
    expect(worker.binaries).toHaveLength(1);
    expect(f.relay.stats().gpu.platePending).toBe(PLATE_LIMITS.maxInFlight);
    expect(camera.ended).toBe(false);
  });
  it("drops a plate reply that correlates to nothing outstanding", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready(plateDescriptor);
    const unknown = plateRequest(room.roomId);
    worker.send(unknown.result);
    await until(() => worker.ended);
    expect(
      camera.messages.some((message) => message.type === "plate.result"),
    ).toBe(false);
  });
  it("rejects a reply whose identity does not match the request", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready(plateDescriptor);
    const request = plateRequest(room.roomId);
    camera.socket.send(request.bytes);
    await until(() => worker.binaries.length === 1);
    worker.send({ ...request.result, trackId: request.header.trackId + 1 });
    await until(() => worker.ended);
    expect(
      camera.messages.some((message) => message.type === "plate.result"),
    ).toBe(false);
  });
  it("times a plate request out without taking the traffic pipeline down", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready(plateDescriptor);
    const request = plateRequest(room.roomId);
    camera.socket.send(request.bytes);
    await until(() => worker.binaries.length === 1);
    f.advance(PLATE_LIMITS.requestTimeoutMs + 1);
    expect(await camera.message("plate.error")).toMatchObject({
      requestId: request.header.requestId,
      code: "timeout",
    });
    // The worker survives, and analysis keeps working through the same socket.
    expect(worker.ended).toBe(false);
    expect(camera.ended).toBe(false);
    const analysis = frame(room.roomId);
    camera.socket.send(analysis.bytes);
    await until(() => worker.binaries.length === 2);
    worker.send(analysis.result);
    expect((await camera.message("inference.result")).frameId).toBe(
      analysis.header.frameId,
    );
  });
  it("refuses further plate work after a timeout but keeps analysing", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready(plateDescriptor);
    const first = plateRequest(room.roomId, { frameSeq: 1 });
    camera.socket.send(first.bytes);
    await until(() => worker.binaries.length === 1);
    f.advance(PLATE_LIMITS.requestTimeoutMs + 1);
    await camera.message("plate.error");
    const second = plateRequest(room.roomId, { frameSeq: 2 });
    camera.socket.send(second.bytes);
    expect(await camera.message("plate.error")).toMatchObject({
      requestId: second.header.requestId,
      code: "unavailable",
    });
    expect(f.relay.stats().gpu.plateEnabled).toBe(false);
    expect(worker.binaries).toHaveLength(1);
  });
  it("never lets plate work consume the analysis depth budget", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready(plateDescriptor);
    const request = plateRequest(room.roomId);
    camera.socket.send(request.bytes);
    await until(() => worker.binaries.length === 1);
    expect(f.relay.stats().gpu.pending).toBe(0);
    const first = frame(room.roomId, 1);
    camera.socket.send(first.bytes);
    await until(() => worker.binaries.length === 2);
    expect(f.relay.stats().gpu).toMatchObject({
      pending: 1,
      platePending: 1,
    });
    worker.send(first.result);
    expect((await camera.message("inference.result")).frameId).toBe(
      first.header.frameId,
    );
    worker.send(request.result);
    expect((await camera.message("plate.result")).requestId).toBe(
      request.header.requestId,
    );
  });
  it("refuses a plate request that names another room", async () => {
    const f = await fixture();
    const { room, camera } = await f.ready(plateDescriptor);
    const other = await f.create(false);
    camera.socket.send(plateRequest(other.roomId).bytes);
    await until(() => camera.ended);
    expect(room.roomId).not.toBe(other.roomId);
  });
  it("refuses a malformed plate envelope without answering it", async () => {
    const f = await fixture();
    const { room, camera } = await f.ready(plateDescriptor);
    const request = plateRequest(room.roomId);
    const corrupted = Buffer.from(request.bytes);
    corrupted[corrupted.length - 1] = 0;
    camera.socket.send(corrupted);
    await until(() => camera.ended);
    expect(
      camera.messages.some((message: Json) => message.type === "plate.result"),
    ).toBe(false);
  });
  it("retires outstanding plate work on cancel instead of dropping the worker", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready(plateDescriptor);
    const request = plateRequest(room.roomId);
    camera.socket.send(request.bytes);
    await until(() => worker.binaries.length === 1);
    camera.send({ v: 1, type: "camera.cancel", roomId: room.roomId });
    await until(() => f.relay.stats().gpu.leased === false);
    // The read is still running on the GPU and its reply is still coming. It
    // must be discarded, not treated as an uncorrelated message: losing the
    // worker over a routine cancel would cost the operator traffic detection.
    expect(f.relay.stats().gpu.platePending).toBe(1);
    worker.send(request.result);
    await until(() => f.relay.stats().gpu.platePending === 0);
    expect(worker.ended).toBe(false);
  });
  it("frees a retired plate slot when its reply never arrives", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready(plateDescriptor);
    camera.socket.send(plateRequest(room.roomId).bytes);
    await until(() => worker.binaries.length === 1);
    camera.send({ v: 1, type: "camera.cancel", roomId: room.roomId });
    await until(() => f.relay.stats().gpu.leased === false);
    f.advance(PLATE_LIMITS.requestTimeoutMs + 1);
    expect(f.relay.stats().gpu.platePending).toBe(0);
    expect(worker.ended).toBe(false);
  });
  it("keeps a plate request from a camera that holds no lease out entirely", async () => {
    const f = await fixture();
    await f.register(plateDescriptor);
    const room = await f.create();
    const stranger = await f.connect("/gpu", "http://127.0.0.1:5173");
    stranger.socket.send(plateRequest(room.roomId).bytes);
    await until(() => stranger.ended);
    expect(f.relay.stats().gpu.platePending).toBe(0);
  });
  it("keeps no plate state once the camera disconnects mid-request", async () => {
    const f = await fixture();
    const { worker, room, camera } = await f.ready(plateDescriptor);
    const request = plateRequest(room.roomId);
    camera.socket.send(request.bytes);
    await until(() => worker.binaries.length === 1);
    camera.socket.terminate();
    await until(() => f.relay.stats().gpu.leased === false);
    // The reply has nowhere to be delivered, so it is discarded on arrival and
    // the slot is freed. No plate state outlives the camera that asked for it.
    worker.send(request.result);
    await until(() => f.relay.stats().gpu.platePending === 0);
    expect(worker.ended).toBe(false);
  });
});
