"""Plate text normalization, candidate selection and crop preprocessing.

These are the parts of the plate pipeline that decide what a reading is allowed
to say. They are tested on synthetic arrays and strings: nothing here measures
OCR accuracy, which is what `training/plates/evaluate.py` is for.
"""
import unittest

import numpy as np

from worker.vision.plates import (
    MAX_TEXT,
    OCR_HEIGHT,
    PREPROCESSORS,
    _select_candidate,
    normalize_text,
    plausibility,
    preprocess_crop,
    sharpness,
)


class NormalizationTests(unittest.TestCase):
    def test_case_and_separators_are_presentation_only(self):
        self.assertEqual(normalize_text("abc1234"), "ABC1234")
        self.assertEqual(normalize_text("ABC-1234"), "ABC1234")
        self.assertEqual(normalize_text(" abc 1234 "), "ABC1234")
        self.assertEqual(normalize_text("abc.1234"), "ABC1234")

    def test_ambiguous_glyphs_are_never_substituted(self):
        # 0/O, 1/I, 5/S and 8/B are exactly the pairs a substitution table would
        # "fix". Doing that here would turn a guess into an assertion, so the
        # reading is passed through untouched and agreement decides later.
        for text in ("0O123", "1I456", "5S789", "8B012"):
            self.assertEqual(normalize_text(text), text)

    def test_readings_outside_the_plate_alphabet_are_refused(self):
        for text in ("", "A", "A" * (MAX_TEXT + 1), "日本", "!!", None, 42, b"ABC123"):
            with self.subTest(text=text):
                self.assertIsNone(normalize_text(text))

    def test_foreign_glyphs_are_dropped_like_any_other_non_plate_mark(self):
        # A crop contains more than the registration, and OCR sometimes returns
        # part of it. Keeping the plate characters is the same rule that turns
        # "ABC-1234" into "ABC1234"; agreement across frames is what decides
        # whether the survivor is actually the plate.
        self.assertEqual(normalize_text("日本1234"), "1234")

    def test_control_characters_never_survive(self):
        self.assertEqual(normalize_text("AB\n12\t34"), "AB1234")
        self.assertIsNone(normalize_text("\x00\x01"))

    def test_plausibility_prefers_plate_shaped_strings(self):
        self.assertGreater(plausibility("ABC1234"), plausibility("CALIFORNIA"))
        self.assertGreater(plausibility("7ABC123"), plausibility("AB"))
        self.assertEqual(plausibility(None), 0.0)
        self.assertEqual(plausibility(""), 0.0)


class CandidateSelectionTests(unittest.TestCase):
    def test_the_plate_wins_over_the_state_name_beside_it(self):
        # A general OCR reads the slogan and the state too; confidence alone
        # would pick the cleanly printed word rather than the registration.
        text, confidence = _select_candidate([
            ("CALIFORNIA", 0.99, 200.0),
            ("ABC1234", 0.86, 220.0),
        ])
        self.assertEqual(text, "ABC1234")
        self.assertAlmostEqual(confidence, 0.86)

    def test_nothing_readable_yields_nothing(self):
        self.assertEqual(_select_candidate([]), (None, None))

    def test_a_single_reading_is_returned_as_is(self):
        self.assertEqual(_select_candidate([("ABC1234", 0.5, 100.0)]), ("ABC1234", 0.5))


def crop(height=40, width=160, value=120):
    image = np.full((height, width, 3), value, dtype=np.uint8)
    image[height // 3: 2 * height // 3, ::7] = 20
    return image


class PreprocessingTests(unittest.TestCase):
    def test_every_variant_produces_the_ocr_working_height(self):
        for variant in PREPROCESSORS:
            with self.subTest(variant=variant):
                output = preprocess_crop(crop(), variant)
                self.assertEqual(output.shape[0], OCR_HEIGHT)
                self.assertEqual(output.shape[2], 3)
                self.assertEqual(output.dtype, np.uint8)

    def test_a_tiny_crop_is_scaled_rather_than_refused(self):
        output = preprocess_crop(crop(8, 24), "clahe")
        self.assertEqual(output.shape[0], OCR_HEIGHT)

    def test_a_very_wide_crop_stays_inside_its_width_bound(self):
        output = preprocess_crop(crop(20, 4000), "none")
        self.assertLessEqual(output.shape[1], 512)

    def test_rectification_leaves_an_unconvincing_crop_alone(self):
        # No dominant quadrilateral means no warp: a bad perspective guess is
        # worse than none, so the crop is only rescaled.
        flat = np.full((40, 160, 3), 128, dtype=np.uint8)
        output = preprocess_crop(flat, "rectify")
        self.assertEqual(output.shape[0], OCR_HEIGHT)
        self.assertTrue(np.isfinite(output).all())

    def test_unsupported_variants_and_inputs_are_refused(self):
        with self.assertRaises(ValueError):
            preprocess_crop(crop(), "superresolution")
        for bad in (np.zeros((4, 4, 4), dtype=np.uint8), np.zeros((4, 4), dtype=np.float32), "image"):
            with self.subTest(bad=type(bad)), self.assertRaises(ValueError):
                preprocess_crop(bad, "clahe")

    def test_grayscale_input_is_accepted_as_a_single_plane(self):
        output = preprocess_crop(np.full((30, 90), 100, dtype=np.uint8), "gray")
        self.assertEqual(output.shape[0], OCR_HEIGHT)

    def test_sharpness_separates_a_blurred_crop_from_a_detailed_one(self):
        import cv2
        detailed = crop()
        blurred = cv2.GaussianBlur(detailed, (0, 0), 3)
        self.assertGreater(sharpness(detailed), sharpness(blurred))
        self.assertEqual(sharpness(np.zeros((4, 4, 3), dtype=np.uint8)), 0.0)


if __name__ == "__main__":
    unittest.main()
