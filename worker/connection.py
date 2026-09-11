"""Outbound connection with one native inference call and a single-slot handoff.

At most one CUDA execution runs at a time. Exactly one newest frame may wait
behind it, so the round trip of frame N overlaps the native work of frame N+1
without ever forming a queue: a third frame displaces the waiting one, which is
reported busy immediately. The relay and the browser client enforce the same
ceiling, so displacement is a defensive path rather than a normal one.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
import logging
import random
import time

from . import protocol


class WorkerConnection:
    def __init__(self, config, detector, *, connector=None, emit=print,
                 heartbeat_seconds=15, stale_seconds=45, register_seconds=5, executor=None):
        self.config = config
        self.detector = detector
        self.connector = connector
        self.emit = emit
        self.heartbeat_seconds = heartbeat_seconds
        self.stale_seconds = stale_seconds
        self.register_seconds = register_seconds
        self.stop = asyncio.Event()
        self.active = None
        # At most one (header, image) waiting behind the active native call.
        self.queued = None
        self.socket = None
        self.generation = 0
        self.last_pong = 0.0
        self.ready = False
        self.executor = executor or ThreadPoolExecutor(max_workers=1, thread_name_prefix="roadlens-gpu")
        self.owns_executor = executor is None

    async def _send(self, socket, message):
        await asyncio.wait_for(socket.send(protocol.encode(message)), timeout=2)

    async def _process_chain(self, socket, generation, header, image):
        """Run this frame, then at most the one newest frame waiting behind it."""
        while True:
            await self._process(socket, generation, header, image)
            header = image = None
            if self.queued is None or self.generation != generation or self.stop.is_set():
                self.queued = None
                return
            header, image = self.queued
            self.queued = None

    async def _process(self, socket, generation, header, image):
        try:
            output = await asyncio.get_running_loop().run_in_executor(self.executor, self.detector.detect_jpeg, image, header["encodedWidth"], header["encodedHeight"])
        except ValueError:
            message = self._error(header, "decode_failed")
        except Exception:
            message = self._error(header, "inference_failed")
        else:
            try:
                message = protocol.result(header, output)
            except Exception:
                message = self._error(header, "inference_failed")
        finally:
            # The worker retains no report, evidence, latest image or result store.
            image = None
        if self.generation == generation and self.socket is socket and not self.stop.is_set():
            try:
                # Ordinary camera.cancel deliberately still completes this exact
                # identity: the relay discards its retired result and releases busy.
                await self._send(socket, message)
            except Exception:
                await socket.close(code=1011, reason="worker_send_failed")

    @staticmethod
    def _error(header, code):
        return {"v": 1, "type": "inference.error", "roomId": header["roomId"], "frameId": header["frameId"], "code": code}

    async def drain(self):
        if self.active is not None:
            # Cancelling an asyncio future cannot stop an already-running CUDA
            # kernel. Never cancel this task or start another native call behind it.
            await asyncio.shield(self.active)
            self.active = None

    def close_executor(self):
        if self.owns_executor:
            self.executor.shutdown(wait=True)

    async def _heartbeat(self, socket):
        try:
            while True:
                await asyncio.sleep(self.heartbeat_seconds)
                if time.monotonic() - self.last_pong > self.stale_seconds:
                    self.emit("Relay heartbeat expired; reconnecting.")
                    await socket.close(code=1011, reason="heartbeat_timeout")
                    return
                await self._send(socket, {"v": 1, "type": "worker.heartbeat"})
        except asyncio.CancelledError:
            raise
        except Exception:
            await socket.close(code=1011, reason="heartbeat_failed")

    async def serve(self, socket):
        """One registration lifetime; socket injection supports protocol tests."""
        await self.drain()
        self.socket = socket
        self.generation += 1
        generation = self.generation
        heartbeat = None
        try:
            await self._send(socket, {"v": 1, "type": "worker.register", "role": "worker", "secret": self.config.secret, "workerVersion": "1"})
            registered = protocol.control(await asyncio.wait_for(socket.recv(), timeout=self.register_seconds))
            protocol.require(registered["type"] == "worker.registered")
            health = await asyncio.get_running_loop().run_in_executor(self.executor, self.detector.health)
            protocol.require(health.get("ready") is True)
            await self._send(socket, {"v": 1, "type": "worker.ready", **protocol.descriptor(health)})
            self.ready = True
            self.last_pong = time.monotonic()
            self.emit("GPU WORKER READY — authenticated outbound relay connected.")
            heartbeat = asyncio.create_task(self._heartbeat(socket))
            async for raw in socket:
                if type(raw) is bytes:
                    header, image = protocol.frame(raw)
                    raw = None
                    if self.active is not None and not self.active.done():
                        if self.queued is not None:
                            displaced, _stale = self.queued
                            # Bounded depth: the newest frame is always the useful
                            # one, so the older waiting frame is released at once.
                            self.queued = None
                            await self._send(socket, self._error(displaced, "busy"))
                        self.queued = (header, image)
                        del image, header
                        continue
                    self.active = asyncio.create_task(self._process_chain(socket, generation, header, image))
                    del image, header
                else:
                    message = protocol.control(raw)
                    if message["type"] == "worker.pong":
                        self.last_pong = time.monotonic()
                    elif message["type"] == "camera.cancel":
                        # Relay owns the single camera lease and fences canceled
                        # identities. Native work stays busy through completion.
                        pass
                    else:
                        raise protocol.ProtocolError("unexpected_worker_message")
        except protocol.ProtocolError:
            await socket.close(code=1008, reason="invalid_worker_message")
            raise
        finally:
            self.ready = False
            self.generation += 1
            self.socket = None
            self.queued = None
            if heartbeat:
                heartbeat.cancel()
                with suppress(asyncio.CancelledError):
                    await heartbeat

    async def request_stop(self):
        self.stop.set()
        self.generation += 1
        if self.socket is not None:
            await self.socket.close(code=1000, reason="worker_shutdown")

    async def run(self):
        if self.connector is None:
            from websockets.asyncio.client import connect
            self.connector = connect
        # A private disabled logger prevents library debug payloads (including
        # first-message machine credentials) even if root logging is verbose.
        logger = logging.Logger("roadlens.worker.transport", level=logging.CRITICAL + 1)
        logger.disabled = True
        attempts = 0
        try:
            while not self.stop.is_set():
                await self.drain()
                connected_at = time.monotonic()
                try:
                    async with self.connector(self.config.relay_url, compression=None, proxy=None,
                                              ping_interval=None, open_timeout=20, close_timeout=2,
                                              max_size=protocol.MAX_MESSAGE, max_queue=1,
                                              write_limit=protocol.MAX_TEXT, user_agent_header=None,
                                              logger=logger) as socket:
                        await self.serve(socket)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self.emit("Relay connection unavailable or rejected; browser fallback remains available.")
                if self.stop.is_set():
                    break
                if time.monotonic() - connected_at > self.stale_seconds:
                    attempts = 0
                delay = min(30, 2 ** min(attempts, 5)) + random.uniform(0, 0.5)
                attempts += 1
                try:
                    await asyncio.wait_for(self.stop.wait(), timeout=delay)
                except TimeoutError:
                    pass
        finally:
            self.generation += 1
            self.ready = False
            await self.drain()
            self.close_executor()
