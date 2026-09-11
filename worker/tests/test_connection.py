"""Synthetic sockets and detector doubles test scheduling, not CUDA execution."""
import asyncio
import json
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from worker.config import Config
from worker.connection import WorkerConnection
from worker.protocol import ProtocolError
from worker.tests.test_protocol import EPOCH, ROOM, SECRET, output, packet, header


class Socket:
    def __init__(self, register=True):
        self.incoming = asyncio.Queue()
        self.sent = []
        self.closed = False
        self.close_code = None
        if register:
            self.feed(dict(v=1, type="worker.registered", serverEpoch=EPOCH))

    def feed(self, value):
        self.incoming.put_nowait(json.dumps(value) if isinstance(value, dict) else value)

    async def send(self, value):
        if self.closed:
            raise ConnectionError("synthetic closed socket")
        self.sent.append(json.loads(value))

    async def recv(self):
        value = await self.incoming.get()
        if value is None:
            raise StopAsyncIteration
        return value

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.recv()

    async def close(self, code=1000, reason=""):
        if not self.closed:
            self.closed = True
            self.close_code = code
            self.incoming.put_nowait(None)


class DetectorDouble:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0
        self.value = output()
        self.failure = None

    def health(self):
        return {**output(), "ready": True}

    def detect_jpeg(self, payload, width, height):
        self.calls += 1
        self.started.set()
        if not self.release.wait(3):
            raise RuntimeError("synthetic test release timeout")
        if self.failure:
            raise self.failure
        return self.value


async def until(predicate):
    async def poll():
        while not predicate():
            await asyncio.sleep(.001)
    await asyncio.wait_for(poll(), 2)


class ConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.detector = DetectorDouble()
        self.logs = []
        self.client = WorkerConnection(Config("wss://relay.example/worker", SECRET), self.detector, emit=self.logs.append)
        self.sockets = []
        self.tasks = []

    async def asyncTearDown(self):
        self.detector.release.set()
        for socket in self.sockets:
            await socket.close()
        for task in self.tasks:
            try:
                await task
            except (ProtocolError, TimeoutError):
                pass
        await self.client.drain()
        self.client.close_executor()

    def start(self, socket=None):
        socket = socket or Socket()
        self.sockets.append(socket)
        task = asyncio.create_task(self.client.serve(socket))
        self.tasks.append(task)
        return socket, task

    async def test_register_first_then_descriptor_ready(self):
        socket, _ = self.start()
        await until(lambda: len(socket.sent) == 2)
        self.assertEqual(socket.sent[0], dict(v=1, type="worker.register", role="worker", secret=SECRET, workerVersion="1"))
        self.assertEqual(socket.sent[1]["type"], "worker.ready")
        self.assertNotIn(SECRET, str(self.logs))
        self.assertNotIn("detections", socket.sent[1])

    def _results(self, socket):
        return [m["frameId"] for m in socket.sent if m["type"] == "inference.result"]

    async def test_one_active_call_with_a_single_waiting_slot_and_cancel_ack(self):
        socket, _ = self.start()
        await until(lambda: self.client.ready)
        socket.feed(packet())
        await until(self.detector.started.is_set)
        socket.feed(packet(header(2)))
        socket.feed(dict(v=1, type="camera.cancel", roomId=ROOM))
        await asyncio.sleep(.05)
        # Exactly one native call runs; the second frame waits rather than
        # executing concurrently, and is not refused.
        self.assertEqual(self.detector.calls, 1)
        self.assertFalse(any(m.get("code") == "busy" for m in socket.sent))
        self.detector.release.set()
        await until(lambda: len(self._results(socket)) == 2)
        # Cancel never abandons work already accepted; both identities complete
        # in submission order and the relay fences anything it no longer wants.
        self.assertEqual(self._results(socket), [f"{EPOCH}:1", f"{EPOCH}:2"])
        self.assertEqual(self.detector.calls, 2)

    async def test_newest_frame_displaces_the_waiting_frame_without_queueing(self):
        socket, _ = self.start()
        await until(lambda: self.client.ready)
        socket.feed(packet())
        await until(self.detector.started.is_set)
        socket.feed(packet(header(2)))
        socket.feed(packet(header(3)))
        await until(lambda: any(m.get("code") == "busy" for m in socket.sent))
        # The older waiting frame is released immediately; depth never exceeds two.
        self.assertEqual([m["frameId"] for m in socket.sent if m.get("code") == "busy"], [f"{EPOCH}:2"])
        self.assertEqual(self.detector.calls, 1)
        self.assertIsNotNone(self.client.queued)
        self.detector.release.set()
        await until(lambda: len(self._results(socket)) == 2)
        self.assertEqual(self._results(socket), [f"{EPOCH}:1", f"{EPOCH}:3"])
        self.assertIsNone(self.client.queued)

    async def test_disconnect_fences_result_and_delays_next_registration(self):
        old, old_task = self.start()
        await until(lambda: self.client.ready)
        old.feed(packet())
        await until(self.detector.started.is_set)
        await old.close()
        await old_task
        new, _ = self.start()
        await asyncio.sleep(.02)
        self.assertEqual(new.sent, [])
        self.assertFalse(self.client.ready)
        self.detector.release.set()
        await until(lambda: self.client.ready)
        self.assertFalse(any(m["type"] == "inference.result" for m in old.sent + new.sent))
        self.assertEqual(self.detector.calls, 1)

    async def test_malformed_payload_closes_connection(self):
        socket, task = self.start()
        await until(lambda: self.client.ready)
        socket.feed(b"bad-frame")
        with self.assertRaises(ProtocolError):
            await task
        self.assertEqual(socket.close_code, 1008)
        self.assertEqual(self.detector.calls, 0)

    async def test_register_timeout_never_ready(self):
        self.client.register_seconds = .01
        socket, task = self.start(Socket(register=False))
        with self.assertRaises(TimeoutError):
            await task
        self.assertFalse(self.client.ready)
        self.assertEqual(len(socket.sent), 1)

    async def test_wrong_first_role_message_rejected(self):
        socket = Socket(register=False)
        socket.feed(dict(v=1, type="worker.pong"))
        socket, task = self.start(socket)
        with self.assertRaises(ProtocolError):
            await task
        self.assertFalse(self.client.ready)

    async def test_unwarmed_detector_never_advertises_ready(self):
        self.detector.health = lambda: {**output(), "ready": False}
        socket, task = self.start()
        with self.assertRaises(ProtocolError):
            await task
        self.assertEqual([m["type"] for m in socket.sent], ["worker.register"])
        self.assertFalse(self.client.ready)

    async def test_heartbeat_expiry_closes_stale_socket(self):
        self.client.heartbeat_seconds = .01
        self.client.stale_seconds = .03
        socket, task = self.start()
        await task
        self.assertTrue(any(m["type"] == "worker.heartbeat" for m in socket.sent))
        self.assertEqual(socket.close_code, 1011)
        self.assertFalse(self.client.ready)

    async def test_pong_refreshes_same_clock_liveness(self):
        socket, _ = self.start()
        await until(lambda: self.client.ready)
        earlier = self.client.last_pong
        await asyncio.sleep(.005)
        socket.feed(dict(v=1, type="worker.pong"))
        await until(lambda: self.client.last_pong > earlier)

    async def test_safe_decode_error(self):
        self.detector.failure = ValueError("secret frame detail must never leave worker")
        self.detector.release.set()
        socket, _ = self.start()
        await until(lambda: self.client.ready)
        socket.feed(packet())
        await until(lambda: any(m["type"] == "inference.error" for m in socket.sent))
        error = socket.sent[-1]
        self.assertEqual(error["code"], "decode_failed")
        self.assertNotIn("secret frame", str(socket.sent) + str(self.logs))

    async def test_invalid_model_output_reports_inference_error(self):
        self.detector.value["detections"][0]["score"] = float("nan")
        self.detector.release.set()
        socket, _ = self.start()
        await until(lambda: self.client.ready)
        socket.feed(packet())
        await until(lambda: any(m["type"] == "inference.error" for m in socket.sent))
        self.assertEqual(socket.sent[-1]["code"], "inference_failed")

    async def test_shutdown_fences_active_result_and_drains_native_call(self):
        socket, task = self.start()
        await until(lambda: self.client.ready)
        socket.feed(packet())
        await until(self.detector.started.is_set)
        await self.client.request_stop()
        await task
        drain = asyncio.create_task(self.client.drain())
        await asyncio.sleep(.01)
        self.assertFalse(drain.done())
        self.detector.release.set()
        await drain
        self.assertFalse(any(m["type"] == "inference.result" for m in socket.sent))

    async def test_reconnect_uses_bounded_transport_and_backoff(self):
        attempts = []
        class FailedConnect:
            async def __aenter__(self):
                raise OSError("do not log transport detail")
            async def __aexit__(self, *_):
                pass
        def connect(url, **kwargs):
            attempts.append(kwargs)
            return FailedConnect()
        self.client.connector = connect
        original_wait = asyncio.wait_for
        delays = []
        async def wait(awaitable, timeout):
            delays.append(timeout)
            awaitable.close()
            if len(delays) == 3:
                self.client.stop.set()
                return True
            raise TimeoutError
        with patch("worker.connection.asyncio.wait_for", wait), patch("worker.connection.random.uniform", return_value=0):
            await self.client.run()
        self.assertEqual(delays, [1, 2, 4])
        self.assertEqual(attempts[0]["max_queue"], 1)
        self.assertEqual(attempts[0]["max_size"], 256 * 1024)
        self.assertIsNone(attempts[0]["compression"])
        self.assertTrue(attempts[0]["logger"].disabled)
        self.assertNotIn("transport detail", str(self.logs))

    async def test_actual_websocket_transport_with_synthetic_detector(self):
        from websockets.asyncio.server import serve
        observed = []
        self.detector.release.set()
        async def relay(socket):
            observed.append(json.loads(await socket.recv()))
            await socket.send(json.dumps(dict(v=1, type="worker.registered", serverEpoch=EPOCH)))
            observed.append(json.loads(await socket.recv()))
            await socket.send(packet())
            observed.append(json.loads(await socket.recv()))
            self.client.stop.set()
            await socket.close()
        async with serve(relay, "127.0.0.1", 0, compression=None) as server:
            port = server.sockets[0].getsockname()[1]
            self.client.config = Config.from_env({"ROADLENS_RELAY_URL": f"ws://127.0.0.1:{port}/worker",
                                                  "ROADLENS_ALLOW_LOOPBACK": "true", "ROADLENS_WORKER_SECRET": SECRET})
            await asyncio.wait_for(self.client.run(), 5)
        self.assertEqual([m["type"] for m in observed], ["worker.register", "worker.ready", "inference.result"])
        self.assertEqual(observed[2]["frameId"], f"{EPOCH}:1")
        self.assertEqual(observed[0]["secret"], SECRET)

    async def test_ctrl_c_during_native_startup_waits_before_same_thread_cleanup(self):
        from worker.main import run
        for stage in ("constructor", "warmup"):
            with self.subTest(stage=stage):
                started = threading.Event()
                release = threading.Event()
                closed = threading.Event()
                threads = []
                class StartupDouble:
                    def __init__(self, **kwargs):
                        threads.append(threading.get_ident())
                        if stage == "constructor":
                            started.set()
                            release.wait(3)
                    def warmup(self, **kwargs):
                        threads.append(threading.get_ident())
                        started.set()
                        release.wait(3)
                    def close(self):
                        threads.append(threading.get_ident())
                        closed.set()
                with patch.dict(sys.modules, {"worker.vision.detector": SimpleNamespace(Detector=StartupDouble)}), patch("builtins.print"):
                    task = asyncio.create_task(run(Config("wss://relay.example/worker", SECRET)))
                    try:
                        await until(started.is_set)
                        task.cancel()
                        await asyncio.sleep(.01)
                        self.assertFalse(closed.is_set())
                        self.assertFalse(task.done())
                    finally:
                        release.set()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                self.assertTrue(closed.is_set())
                self.assertEqual(len(set(threads)), 1)


if __name__ == "__main__":
    unittest.main()
