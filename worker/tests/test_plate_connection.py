"""Plate scheduling on the worker: bounded, optional and always subordinate.

Synthetic sockets and doubles. Nothing here executes CUDA or reads a real plate;
these tests exist to prove that plate work can never stall, queue in front of, or
take down the traffic detector.
"""
import asyncio
import threading
import unittest
import unittest.mock

from worker.config import Config
from worker.connection import WorkerConnection
from worker.protocol import ProtocolError
from worker.tests.test_connection import DetectorDouble, Socket, until
from worker.tests.test_protocol import ROOM, SECRET, header, packet
from worker.tests.test_plate_protocol import DESCRIPTOR, plate_header, plate_packet, reading


class PlateReaderDouble:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.calls = 0
        self.value = reading()
        self.failure = None

    def descriptor(self):
        return dict(DESCRIPTOR)

    def read_jpeg(self, payload, width, height):
        self.calls += 1
        self.started.set()
        if not self.release.wait(3):
            raise RuntimeError("synthetic test release timeout")
        if self.failure:
            raise self.failure
        return self.value

    def close(self):
        pass


class PlateConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.detector = DetectorDouble()
        self.detector.release.set()
        self.reader = PlateReaderDouble()
        self.logs = []
        self.sockets = []
        self.tasks = []
        self.client = None

    def build(self, plate_reader):
        self.client = WorkerConnection(Config("wss://relay.example/worker", SECRET), self.detector,
                                       emit=self.logs.append, plate_reader=plate_reader)
        return self.client

    async def asyncTearDown(self):
        self.detector.release.set()
        self.reader.release.set()
        for socket in self.sockets:
            await socket.close()
        for task in self.tasks:
            try:
                await task
            except (ProtocolError, TimeoutError):
                pass
        if self.client:
            await self.client.drain()
            self.client.close_executor()

    def start(self, plate_reader=None, socket=None):
        client = self.build(plate_reader)
        socket = socket or Socket()
        self.sockets.append(socket)
        self.tasks.append(asyncio.create_task(client.serve(socket)))
        return socket

    @staticmethod
    def kinds(socket, kind):
        return [message for message in socket.sent if message["type"] == kind]

    async def test_ready_omits_plate_when_the_worker_has_none(self):
        socket = self.start(None)
        await until(lambda: len(socket.sent) == 2)
        self.assertEqual(socket.sent[1]["type"], "worker.ready")
        self.assertNotIn("plate", socket.sent[1])

    async def test_ready_advertises_a_loaded_plate_pipeline(self):
        socket = self.start(self.reader)
        await until(lambda: len(socket.sent) == 2)
        self.assertEqual(socket.sent[1]["plate"], DESCRIPTOR)

    async def test_request_without_a_plate_pipeline_is_answered_unavailable(self):
        socket = self.start(None)
        await until(lambda: self.client.ready)
        socket.feed(plate_packet())
        await until(lambda: self.kinds(socket, "plate.error"))
        self.assertEqual(self.kinds(socket, "plate.error")[0]["code"], "unavailable")
        self.assertEqual(self.reader.calls, 0)

    async def test_reading_is_returned_with_its_request_identity(self):
        socket = self.start(self.reader)
        await until(lambda: self.client.ready)
        socket.feed(plate_packet())
        await until(lambda: self.kinds(socket, "plate.result"))
        result = self.kinds(socket, "plate.result")[0]
        self.assertEqual(result["requestId"], plate_header()["requestId"])
        self.assertEqual(result["trackId"], plate_header()["trackId"])
        self.assertEqual(result["plateText"], "ABC1234")
        self.assertEqual(result["ocrEngine"], DESCRIPTOR["ocrEngine"])

    async def test_plate_work_is_refused_while_analysis_is_running(self):
        socket = self.start(self.reader)
        await until(lambda: self.client.ready)
        self.detector.release.clear()
        socket.feed(packet())
        await until(self.detector.started.is_set)
        socket.feed(plate_packet())
        await until(lambda: self.kinds(socket, "plate.error"))
        # Refused outright rather than queued: the next analysis frame must never
        # find plate work sitting in front of it.
        self.assertEqual(self.kinds(socket, "plate.error")[0]["code"], "busy")
        self.assertEqual(self.reader.calls, 0)
        self.detector.release.set()

    async def test_plate_work_is_refused_while_a_frame_is_waiting(self):
        socket = self.start(self.reader)
        await until(lambda: self.client.ready)
        self.detector.release.clear()
        socket.feed(packet())
        await until(self.detector.started.is_set)
        socket.feed(packet(header(2)))
        await until(lambda: self.client.queued is not None)
        socket.feed(plate_packet())
        await until(lambda: self.kinds(socket, "plate.error"))
        self.assertEqual(self.kinds(socket, "plate.error")[0]["code"], "busy")
        self.assertEqual(self.reader.calls, 0)
        self.detector.release.set()

    async def test_only_one_plate_task_exists_at_a_time(self):
        socket = self.start(self.reader)
        await until(lambda: self.client.ready)
        self.reader.release.clear()
        socket.feed(plate_packet())
        await until(self.reader.started.is_set)
        socket.feed(plate_packet(plate_header(2)))
        await until(lambda: self.kinds(socket, "plate.error"))
        self.assertEqual(self.kinds(socket, "plate.error")[0]["code"], "busy")
        self.assertEqual(self.reader.calls, 1)
        self.reader.release.set()

    async def test_analysis_still_completes_while_a_plate_read_is_running(self):
        socket = self.start(self.reader)
        await until(lambda: self.client.ready)
        self.reader.release.clear()
        socket.feed(plate_packet())
        await until(self.reader.started.is_set)
        # An analysis frame arriving mid-read is accepted, not refused; it is
        # only ever delayed by the bounded plate call already in the executor.
        socket.feed(packet())
        self.reader.release.set()
        await until(lambda: self.kinds(socket, "inference.result"))
        self.assertFalse(any(message.get("code") == "busy"
                             for message in self.kinds(socket, "inference.error")))

    async def test_a_failing_reader_reports_and_leaves_analysis_alive(self):
        socket = self.start(self.reader)
        await until(lambda: self.client.ready)
        self.reader.failure = RuntimeError("synthetic plate failure")
        socket.feed(plate_packet())
        await until(lambda: self.kinds(socket, "plate.error"))
        self.assertEqual(self.kinds(socket, "plate.error")[0]["code"], "plate_failed")
        socket.feed(packet())
        await until(lambda: self.kinds(socket, "inference.result"))
        self.assertFalse(socket.closed)

    async def test_a_decode_failure_is_reported_as_such(self):
        socket = self.start(self.reader)
        await until(lambda: self.client.ready)
        self.reader.failure = ValueError("synthetic decode failure")
        socket.feed(plate_packet())
        await until(lambda: self.kinds(socket, "plate.error"))
        self.assertEqual(self.kinds(socket, "plate.error")[0]["code"], "decode_failed")

    async def test_a_malformed_request_closes_the_socket_without_reading(self):
        socket = self.start(self.reader)
        await until(lambda: self.client.ready)
        socket.feed(b"RLP1" + b"\x00\x00\x00\x02" + b"{}" + b"\xff\xd8\xff\xd9")
        await until(lambda: socket.closed)
        self.assertEqual(socket.close_code, 1008)
        self.assertEqual(self.reader.calls, 0)

    async def test_a_late_reading_is_not_sent_after_the_connection_moved_on(self):
        socket = self.start(self.reader)
        await until(lambda: self.client.ready)
        self.reader.release.clear()
        socket.feed(plate_packet())
        await until(self.reader.started.is_set)
        # The registration lifetime ends while the read is still in the executor.
        self.client.generation += 1
        self.reader.release.set()
        await asyncio.sleep(.05)
        self.assertEqual(self.kinds(socket, "plate.result"), [])

    async def test_the_worker_retains_no_reading_between_requests(self):
        socket = self.start(self.reader)
        await until(lambda: self.client.ready)
        socket.feed(plate_packet())
        await until(lambda: self.kinds(socket, "plate.result"))
        await self.client.drain()
        self.assertIsNone(self.client.plate_active)
        self.assertNotIn("ABC1234", repr(self.client.__dict__))


if __name__ == "__main__":
    unittest.main()


class PlateAvailabilityTests(unittest.TestCase):
    """Plate recognition is an enhancement; failing to load it is not fatal."""

    def config(self, plate="auto"):
        return Config("wss://relay.example/worker", SECRET, plate=plate)

    def test_disabled_configuration_loads_nothing_at_all(self):
        from worker.main import load_plate_reader
        with unittest.mock.patch("worker.vision.plates.PlateDetector") as detector:
            self.assertIsNone(load_plate_reader(self.config("off")))
            detector.assert_not_called()

    def test_a_missing_plate_model_downgrades_to_traffic_only(self):
        from worker.main import load_plate_reader
        with unittest.mock.patch("worker.vision.plates.PlateDetector",
                                 side_effect=RuntimeError("plate model missing")):
            self.assertIsNone(load_plate_reader(self.config("auto")))

    def test_a_missing_ocr_engine_downgrades_to_traffic_only(self):
        from worker.main import load_plate_reader
        with (unittest.mock.patch("worker.vision.plates.PlateDetector"),
              unittest.mock.patch("worker.vision.plates.load_ocr",
                                  side_effect=ImportError("no OCR package"))):
            self.assertIsNone(load_plate_reader(self.config("auto")))

    def test_required_plate_support_refuses_to_start_silently_degraded(self):
        from worker.main import load_plate_reader
        with unittest.mock.patch("worker.vision.plates.PlateDetector",
                                 side_effect=RuntimeError("plate model missing")):
            with self.assertRaises(RuntimeError):
                load_plate_reader(self.config("on"))

    def test_a_loaded_pipeline_is_warmed_before_it_is_advertised(self):
        from worker.main import load_plate_reader
        with (unittest.mock.patch("worker.vision.plates.PlateDetector"),
              unittest.mock.patch("worker.vision.plates.load_ocr"),
              unittest.mock.patch("worker.vision.plates.PlateReader") as reader):
            self.assertIsNotNone(load_plate_reader(self.config("auto")))
            reader.return_value.warmup.assert_called_once()
