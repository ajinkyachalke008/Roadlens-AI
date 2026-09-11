"""Synthetic contract fixtures; none of these tests prove NVIDIA inference."""
import copy
import json
import struct
import unittest

from worker import protocol as p
from worker.config import Config, ConfigurationError

ROOM = "10000000-0000-4000-8000-000000000001"
SOURCE = "10000000-0000-4000-8000-000000000002"
EPOCH = "10000000-0000-4000-8000-000000000003"
SECRET = "a" * 43


def jpeg(width=640, height=480):
    # SOF-only synthetic envelope fixture, intentionally not an inference image.
    return b"\xff\xd8\xff\xc0\x00\x0b\x08" + struct.pack(">HH", height, width) + b"\x01\x01\x11\x00\xff\xd9"


def header(seq=1):
    return dict(v=1, type="camera.frame", roomId=ROOM, sourceId=SOURCE,
                captureEpoch=EPOCH, frameSeq=seq, frameId=f"{EPOCH}:{seq}", sourceTimeMs=1234.5,
                sourceWidth=1280, sourceHeight=960, encodedWidth=640, encodedHeight=480,
                imageLength=len(jpeg()), format="image/jpeg")


def packet(value=None, payload=None):
    value = header() if value is None else value
    payload = jpeg() if payload is None else payload
    encoded = json.dumps(value, separators=(",", ":")).encode()
    return b"RLG1" + struct.pack(">I", len(encoded)) + encoded + payload


def output():
    return dict(modelId="synthetic-test-only", modelSha256="a" * 64, runtime="pytorch_cuda", inputSize=640,
                detections=[dict(className="car", score=.8, bbox=[.1, .2, .5, .8])],
                timing=dict(decodeMs=1, preprocessMs=2, inferenceMs=3, postprocessMs=4, totalMs=10))


class ProtocolTests(unittest.TestCase):
    def test_valid_frame_preserves_all_identity(self):
        parsed, image = p.frame(packet())
        self.assertEqual(parsed, header())
        self.assertEqual(image, jpeg())
        result = p.result(parsed, output())
        for key in p.IDENTITY_KEYS:
            self.assertEqual(result[key], parsed[key])
        self.assertNotIn("imageLength", result)
        self.assertNotIn("format", result)
        self.assertEqual(result["metrics"]["inferenceMs"], 3)

    def test_malformed_envelope_caps_lengths_utf8(self):
        good = packet()
        for bad in (b"", b"RLN2" + good[4:], good[:-1], good + b"x", b"RLG1" + struct.pack(">I", 4097) + good[8:],
                    b"RLG1" + struct.pack(">I", 2) + b"\xff\xfe" + jpeg(), good + bytes(p.MAX_MESSAGE),
                    b"RLG1" + struct.pack(">I", 1) + b"{" + jpeg()):
            with self.subTest(length=len(bad)), self.assertRaises(p.ProtocolError):
                p.frame(bad)

    def test_missing_extra_role_fields_fail(self):
        values = []
        for key in header():
            value = header()
            del value[key]
            values.append(value)
        values.append({**header(), "role": "worker"})
        for value in values:
            with self.subTest(keys=list(value)), self.assertRaises(p.ProtocolError):
                p.frame(packet(value))

    def test_identity_and_finite_numbers(self):
        for key, bad in (("frameSeq", True), ("frameSeq", -1), ("frameSeq", 1.5), ("frameSeq", 2 ** 53),
                         ("sourceTimeMs", float("nan")), ("sourceTimeMs", float("inf")), ("sourceTimeMs", 2 ** 53),
                         ("roomId", "not-a-uuid"), ("sourceId", []), ("captureEpoch", "x"),
                         ("frameId", f"{EPOCH}:2"), ("v", True), ("v", 2), ("format", "image/png")):
            with self.subTest(key=key, bad=bad), self.assertRaises(p.ProtocolError):
                p.frame(packet({**header(), key: bad}))

    def test_dimension_aspect_upscale_and_pixel_gates(self):
        for change in ({"encodedWidth": 961}, {"sourceWidth": 0}, {"sourceHeight": 8193},
                       {"sourceWidth": 4097, "sourceHeight": 4097}, {"sourceWidth": 320, "sourceHeight": 240},
                       {"encodedHeight": 400}, {"sourceWidth": True}, {"imageLength": p.MAX_IMAGE + 1}):
            with self.subTest(change=change), self.assertRaises(p.ProtocolError):
                p.frame(packet({**header(), **change}))

    def test_jpeg_sof_disagrees_before_decode(self):
        with self.assertRaises(p.ProtocolError):
            p.frame(packet(payload=jpeg(640, 479)))
        for bad in (b"\xff\xd8\xff\xd9", b"\xff\xd8\xff\xc0\x00\x01\xff\xd9", jpeg(961, 480), jpeg()[:-2] + b"xx"):
            with self.assertRaises(p.ProtocolError):
                p.jpeg_dimensions(bad)

    def test_strict_json_duplicate_and_nonobjects(self):
        for raw in ('{"v":1,"v":1,"type":"worker.pong"}', '[]', 'null', '{"v":NaN,"type":"worker.pong"}',
                    '{"v":1,"type":"worker.pong","secret":"x"}', '{"v":1,"type":"unknown"}'):
            with self.subTest(raw=raw), self.assertRaises(p.ProtocolError):
                p.control(raw)

    def test_control_schemas(self):
        for value in (dict(v=1, type="worker.pong"), dict(v=1, type="worker.registered", serverEpoch=EPOCH), dict(v=1, type="camera.cancel", roomId=ROOM)):
            self.assertEqual(p.control(p.encode(value)), value)

    def test_result_rejects_unknown_class_and_invalid_boxes(self):
        for change in ({"className": "COCO:2"}, {"className": []}, {"score": float("nan")}, {"bbox": [.2, .2, .1, .3]},
                       {"bbox": [-1, .1, .5, .6]}, {"bbox": [True, .1, .5, .6]}, {"bbox": [.1, .2, .3]}, {"role": "camera"}):
            value = output()
            value["detections"][0].update(change)
            with self.subTest(change=change), self.assertRaises(p.ProtocolError):
                p.result(header(), value)

    def test_result_caps_model_descriptor_and_timings(self):
        values = [{**output(), "detections": output()["detections"] * 101}, {**output(), "modelSha256": "wrong"},
                  {**output(), "runtime": "cpu"}, {**output(), "inputSize": 416}, {**output(), "modelId": ""}]
        for timing in (float("nan"), -1, 60001, True):
            value = output()
            value["timing"]["totalMs"] = timing
            values.append(value)
        for value in values:
            with self.assertRaises(p.ProtocolError):
                p.result(header(), value)

    def test_encoding_disallows_nan_and_text_overflow(self):
        for value in ({"x": float("nan")}, {"x": "x" * p.MAX_TEXT}):
            with self.assertRaises(p.ProtocolError):
                p.encode(value)


class ConfigTests(unittest.TestCase):
    def env(self, **extra):
        return {"ROADLENS_RELAY_URL": "wss://relay.example/worker", "ROADLENS_WORKER_SECRET": SECRET, **extra}

    def test_wss_valid_and_secret_not_in_repr(self):
        config = Config.from_env(self.env())
        self.assertEqual(config.runtime, "pytorch_cuda")
        self.assertNotIn(SECRET, repr(config))

    def test_public_insecure_and_credentials_rejected(self):
        for url in ("ws://relay.example/worker", "https://relay.example/worker", "wss://user:secret@relay.example/worker", "wss://relay.example/worker?secret=x", "wss://relay.example/worker#x", "wss://relay.example/", "wss://relay.example:bad/worker"):
            with self.subTest(url=url), self.assertRaises(ConfigurationError):
                Config.from_env(self.env(ROADLENS_RELAY_URL=url, ROADLENS_ALLOW_LOOPBACK="true"))

    def test_loopback_ws_requires_explicit_permission(self):
        for host in ("127.0.0.1", "localhost", "[::1]"):
            values = self.env(ROADLENS_RELAY_URL=f"ws://{host}:10000/worker")
            with self.assertRaises(ConfigurationError):
                Config.from_env(values)
            Config.from_env({**values, "ROADLENS_ALLOW_LOOPBACK": "true"})

    def test_invalid_secret_cpu_and_runtime_fail_safely(self):
        for change in ({"ROADLENS_WORKER_SECRET": "secret-value-invalid"}, {"ALLOW_WORKER_CPU_FALLBACK": "true"},
                       {"ROADLENS_GPU_RUNTIME": "cpu"}, {"ROADLENS_GPU_DEVICE": "-1"}, {"ROADLENS_MODEL_MODE": "giant"}):
            with self.assertRaises(ConfigurationError) as result:
                Config.from_env(self.env(**change))
            self.assertNotIn("secret-value-invalid", str(result.exception))


if __name__ == "__main__":
    unittest.main()
