"""Synthetic plate transport fixtures; none of these tests prove OCR accuracy."""
import copy
import json
import struct
import unittest

from worker import protocol as p
from worker.tests.test_protocol import EPOCH, ROOM, SOURCE, jpeg

REQUEST = "10000000-0000-4000-8000-000000000004"
DESCRIPTOR = dict(detectorId="synthetic-plate-only", detectorSha256="b" * 64,
                  ocrEngine="synthetic-ocr", inputSize=640)


def plate_header(seq=1, **over):
    value = dict(v=1, type="camera.plate", roomId=ROOM, sourceId=SOURCE, captureEpoch=EPOCH,
                 requestId=REQUEST, frameSeq=seq, frameId=f"{EPOCH}:{seq}", trackId=5,
                 sourceTimeMs=1234.5, sourceWidth=1920, sourceHeight=1080,
                 cropX=.25, cropY=.3, cropWidth=.2, cropHeight=.25,
                 encodedWidth=320, encodedHeight=240, imageLength=len(jpeg(320, 240)),
                 format="image/jpeg")
    value.update(over)
    return value


def plate_packet(value=None, payload=None):
    value = plate_header() if value is None else value
    payload = jpeg(320, 240) if payload is None else payload
    encoded = json.dumps(value, separators=(",", ":")).encode()
    return b"RLP1" + struct.pack(">I", len(encoded)) + encoded + payload


def reading(**over):
    value = dict(plateText="ABC1234", plateConfidence=.92, detectorConfidence=.81,
                 plateBox=[.1, .3, .7, .55],
                 timing=dict(decodeMs=1, detectMs=3, ocrMs=4, totalMs=9))
    value.update(over)
    return value


class PlateEnvelopeTests(unittest.TestCase):
    def test_valid_request_preserves_all_identity(self):
        parsed, image = p.plate_frame(plate_packet())
        self.assertEqual(parsed, plate_header())
        self.assertEqual(image, jpeg(320, 240))
        result = p.plate_result(parsed, reading(), DESCRIPTOR)
        for key in p.PLATE_IDENTITY_KEYS:
            self.assertEqual(result[key], parsed[key])
        # Crop geometry describes the submitted image, not the answer; it must
        # not leak back into the reply.
        for key in ("cropX", "cropY", "cropWidth", "cropHeight", "imageLength", "format"):
            self.assertNotIn(key, result)

    def test_plate_and_analysis_envelopes_are_distinguishable(self):
        self.assertTrue(p.is_plate_frame(plate_packet()))
        self.assertFalse(p.is_plate_frame(b"RLG1" + plate_packet()[4:]))
        with self.assertRaises(p.ProtocolError):
            p.plate_frame(b"RLG1" + plate_packet()[4:])

    def test_malformed_envelope_is_rejected(self):
        good = plate_packet()
        for bad in (b"", b"RLP2" + good[4:], good[:-1], good + b"x",
                    b"RLP1" + struct.pack(">I", p.PLATE_MAX_HEADER + 1) + good[8:],
                    b"RLP1" + struct.pack(">I", 2) + b"\xff\xfe" + jpeg(320, 240),
                    good + bytes(p.PLATE_MAX_MESSAGE),
                    b"RLP1" + struct.pack(">I", 1) + b"{" + jpeg(320, 240)):
            with self.subTest(length=len(bad)), self.assertRaises(p.ProtocolError):
                p.plate_frame(bad)

    def test_crop_must_lie_inside_its_own_source_frame(self):
        for over in (dict(cropX=.9), dict(cropY=.95), dict(cropWidth=0), dict(cropHeight=0),
                     dict(cropWidth=1.1), dict(cropX=-.1)):
            with self.subTest(**over), self.assertRaises(p.ProtocolError):
                p.plate_frame(plate_packet(plate_header(**over)))

    def test_crop_too_small_to_read_is_rejected(self):
        small = p.PLATE_MIN_CROP_EDGE - 1
        with self.assertRaises(p.ProtocolError):
            p.plate_frame(plate_packet(
                plate_header(encodedWidth=small, encodedHeight=small,
                             imageLength=len(jpeg(small, small))),
                jpeg(small, small)))

    def test_declared_dimensions_must_match_the_actual_jpeg(self):
        with self.assertRaises(p.ProtocolError):
            p.plate_frame(plate_packet(plate_header(), jpeg(320, 241)))

    def test_identity_fields_are_validated(self):
        for over in (dict(roomId="not-a-uuid"), dict(requestId="nope"),
                     dict(frameId=f"{EPOCH}:2"), dict(trackId=-1), dict(trackId=1.5),
                     dict(type="camera.frame"), dict(v=2), dict(format="image/png")):
            with self.subTest(**over), self.assertRaises(p.ProtocolError):
                p.plate_frame(plate_packet(plate_header(**over)))

    def test_unknown_header_keys_are_rejected(self):
        value = plate_header()
        value["extra"] = 1
        with self.assertRaises(p.ProtocolError):
            p.plate_frame(plate_packet(value))


class PlateResultTests(unittest.TestCase):
    def setUp(self):
        self.header, _image = p.plate_frame(plate_packet())

    def test_unread_plate_is_a_valid_observation(self):
        result = p.plate_result(self.header, reading(plateText=None, plateConfidence=None), DESCRIPTOR)
        self.assertIsNone(result["plateText"])
        self.assertIsNone(result["plateConfidence"])
        self.assertEqual(result["detectorConfidence"], .81)

    def test_text_and_confidence_travel_together(self):
        for over in (dict(plateConfidence=None), dict(plateText=None)):
            with self.subTest(**over), self.assertRaises(p.ProtocolError):
                p.plate_result(self.header, reading(**over), DESCRIPTOR)

    def test_only_plate_characters_are_accepted(self):
        for text in ("abc1234", "AB!123", "", "A", "ABCDEFGHIJK", " AB12", "AB\n12"):
            with self.subTest(text=text), self.assertRaises(p.ProtocolError):
                p.plate_result(self.header, reading(plateText=text), DESCRIPTOR)
        for text in ("ABC1234", "AB-1234", "1A 2B3", "7Z"):
            with self.subTest(text=text):
                self.assertEqual(
                    p.plate_result(self.header, reading(plateText=text), DESCRIPTOR)["plateText"], text)

    def test_degenerate_plate_box_is_rejected(self):
        for box in ([.7, .3, .1, .55], [.1, .5, .7, .5], [0, 0, 2, 1], "box", [.1, .2, .3]):
            with self.subTest(box=box), self.assertRaises(p.ProtocolError):
                p.plate_result(self.header, reading(plateBox=box), DESCRIPTOR)

    def test_descriptor_must_be_complete_and_well_formed(self):
        for over in (dict(detectorSha256="short"), dict(ocrEngine=""), dict(inputSize=64),
                     dict(detectorId=""), dict(inputSize="640")):
            broken = copy.deepcopy(DESCRIPTOR)
            broken.update(over)
            with self.subTest(**over), self.assertRaises(p.ProtocolError):
                p.plate_result(self.header, reading(), broken)

    def test_timing_keys_are_exact(self):
        for timing in (dict(decodeMs=1, detectMs=2, ocrMs=3),
                       dict(decodeMs=1, detectMs=2, ocrMs=3, totalMs=4, extra=5),
                       dict(decodeMs=1, detectMs=2, ocrMs=3, totalMs=60001)):
            with self.subTest(timing=timing), self.assertRaises(p.ProtocolError):
                p.plate_result(self.header, reading(timing=timing), DESCRIPTOR)

    def test_errors_name_only_fixed_categories(self):
        for code in p.PLATE_ERRORS:
            message = p.plate_error(self.header, code)
            self.assertEqual(message, dict(v=1, type="plate.error", roomId=ROOM,
                                           requestId=REQUEST, code=code))
        for code in ("no_plate", "", "inference_failed"):
            with self.subTest(code=code), self.assertRaises(p.ProtocolError):
                p.plate_error(self.header, code)

    def test_result_encodes_within_the_text_budget(self):
        encoded = p.encode(p.plate_result(self.header, reading(), DESCRIPTOR))
        self.assertLess(len(encoded.encode()), p.MAX_TEXT)


if __name__ == "__main__":
    unittest.main()
