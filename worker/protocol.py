"""Strict RLG1 transport validation, matching shared/src/gpu.ts.

Frame bytes exist only for the current synchronous detector call. Fixtures in
worker/tests are protocol tests, not evidence of GPU correctness.
"""
import json
import math
import re
import struct

MAX_MESSAGE = 256 * 1024
MAX_HEADER = 4096
MAX_IMAGE = 192 * 1024
MAX_TEXT = 32 * 1024
MAX_SAFE_INTEGER = 9007199254740991
CLASSES = {"person", "bicycle", "car", "motorcycle", "bus", "truck"}
RUNTIMES = {"pytorch_cuda", "onnx_cuda", "tensorrt"}
IDENTITY_KEYS = {"roomId", "sourceId", "captureEpoch", "frameSeq", "frameId", "sourceTimeMs", "sourceWidth", "sourceHeight", "encodedWidth", "encodedHeight"}
UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")


class ProtocolError(ValueError):
    """Intentionally contains only a fixed safe error category."""


def require(condition):
    if not condition:
        raise ProtocolError("invalid_worker_message")


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys))


def number(value, minimum=0, maximum=float("inf"), integer=False):
    require(type(value) in {int, float} and minimum <= value <= maximum and math.isfinite(value))
    if integer:
        require(int(value) == value)


def identifier(value):
    require(type(value) is str and (UUID.fullmatch(value) is not None or value in {"00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"}))


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def parse_json(value, limit=MAX_HEADER):
    try:
        if isinstance(value, bytes):
            require(len(value) <= limit)
            value = value.decode("utf-8", errors="strict")
        require(type(value) is str and len(value.encode("utf-8")) <= limit)
        return json.loads(value, object_pairs_hook=_pairs, parse_constant=lambda _: require(False))
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise ProtocolError("invalid_worker_message") from None


def encode(message):
    try:
        result = json.dumps(message, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        require(len(result.encode("utf-8")) <= MAX_TEXT)
        return result
    except (TypeError, ValueError, UnicodeError):
        raise ProtocolError("invalid_worker_message") from None


def control(raw):
    message = parse_json(raw)
    require(type(message) is dict and type(message.get("v")) is int and message["v"] == 1)
    kind = message.get("type")
    if kind == "worker.registered":
        exact(message, {"v", "type", "serverEpoch"})
        identifier(message["serverEpoch"])
    elif kind == "worker.pong":
        exact(message, {"v", "type"})
    elif kind == "camera.cancel":
        exact(message, {"v", "type", "roomId"})
        identifier(message["roomId"])
    else:
        raise ProtocolError("invalid_worker_message")
    return message


def jpeg_dimensions(payload):
    """Inspect SOF without allocating decoded pixels; reject malformed segments."""
    require(len(payload) >= 4 and payload[:2] == b"\xff\xd8" and payload[-2:] == b"\xff\xd9")
    offset = 2
    while offset < len(payload) - 2:
        require(payload[offset] == 0xff)
        while offset < len(payload) and payload[offset] == 0xff:
            offset += 1
        require(offset < len(payload))
        marker = payload[offset]
        offset += 1
        require(marker not in {0, 0xd8, 0xd9, 0xda})
        if marker == 1 or 0xd0 <= marker <= 0xd7:
            continue
        require(offset + 2 <= len(payload))
        size = int.from_bytes(payload[offset:offset + 2], "big")
        require(size >= 2 and offset + size <= len(payload))
        if marker in {0xc0, 0xc2}:
            require(size >= 8 and payload[offset + 2] == 8)
            height = int.from_bytes(payload[offset + 3:offset + 5], "big")
            width = int.from_bytes(payload[offset + 5:offset + 7], "big")
            require(1 <= width <= 960 and 1 <= height <= 960)
            return width, height
        offset += size
    raise ProtocolError("invalid_worker_message")


def frame(raw):
    require(type(raw) is bytes and 12 <= len(raw) <= MAX_MESSAGE and raw[:4] == b"RLG1")
    size = struct.unpack(">I", raw[4:8])[0]
    require(2 <= size <= MAX_HEADER and 8 + size < len(raw))
    header = parse_json(raw[8:8 + size])
    exact(header, IDENTITY_KEYS | {"v", "type", "imageLength", "format"})
    require(type(header["v"]) is int and header["v"] == 1 and header["type"] == "camera.frame" and header["format"] == "image/jpeg")
    for key in ("roomId", "sourceId", "captureEpoch"):
        identifier(header[key])
    number(header["frameSeq"], maximum=MAX_SAFE_INTEGER, integer=True)
    require(header["frameId"] == f'{header["captureEpoch"]}:{int(header["frameSeq"])}')
    number(header["sourceTimeMs"], maximum=MAX_SAFE_INTEGER)
    for key in ("sourceWidth", "sourceHeight"):
        number(header[key], 1, 8192, True)
    require(header["sourceWidth"] * header["sourceHeight"] <= 16_777_216)
    for key in ("encodedWidth", "encodedHeight"):
        number(header[key], 1, 960, True)
    require(header["encodedWidth"] <= header["sourceWidth"] and header["encodedHeight"] <= header["sourceHeight"])
    require(abs(header["encodedWidth"] * header["sourceHeight"] - header["encodedHeight"] * header["sourceWidth"]) <= max(header["sourceWidth"], header["sourceHeight"]))
    number(header["imageLength"], 4, MAX_IMAGE, True)
    image = raw[8 + size:]
    require(len(image) == header["imageLength"])
    require(jpeg_dimensions(image) == (header["encodedWidth"], header["encodedHeight"]))
    return header, image


def descriptor(value):
    result = {key: value.get(key) for key in ("modelId", "modelSha256", "runtime", "inputSize")}
    require(type(result["modelId"]) is str and 1 <= len(result["modelId"].encode("utf-16-le")) // 2 <= 160)
    require(type(result["modelSha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", result["modelSha256"]) is not None)
    require(type(result["runtime"]) is str and result["runtime"] in RUNTIMES and type(result["inputSize"]) is int and result["inputSize"] == 640)
    return result


def result(header, output):
    require(type(output) is dict)
    detections = output.get("detections")
    require(type(detections) is list and len(detections) <= 100)
    for detection in detections:
        exact(detection, {"className", "score", "bbox"})
        require(type(detection["className"]) is str and detection["className"] in CLASSES)
        number(detection["score"], 0, 1)
        bbox = detection["bbox"]
        require(type(bbox) in {list, tuple} and len(bbox) == 4)
        for coordinate in bbox:
            number(coordinate, 0, 1)
        require(bbox[2] > bbox[0] and bbox[3] > bbox[1])
    metrics = output.get("timing")
    exact(metrics, {"decodeMs", "preprocessMs", "inferenceMs", "postprocessMs", "totalMs"})
    for timing in metrics.values():
        number(timing, maximum=60000)
    return {"v": 1, "type": "inference.result", **{key: header[key] for key in IDENTITY_KEYS}, **descriptor(output), "detections": detections, "metrics": metrics}
