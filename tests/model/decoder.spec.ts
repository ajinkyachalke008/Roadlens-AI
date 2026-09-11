import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { decode } from "../../frontend/src/inference/decode";
import {
  letterbox,
  preprocessRgba,
  invertBox,
} from "../../frontend/src/inference/preprocess";
import { validateManifest } from "../../frontend/src/inference/manifest";
import type { ModelManifest } from "../../frontend/src/inference/types";
const manifest = JSON.parse(
  readFileSync("frontend/public/models/yolo26n-320.json", "utf8"),
) as ModelManifest;
test("B02 explicit six-class mapping uses sequential custom bus=4 and truck=5", () => {
  const custom: ModelManifest = {
    ...manifest,
    classCount: 6,
    classMap: {
      0: "person",
      1: "bicycle",
      2: "car",
      3: "motorcycle",
      4: "bus",
      5: "truck",
    },
    output: { ...manifest.output, shape: [1, 2, 6] },
  };
  const detections = decode(
    new Float32Array([10, 10, 100, 100, 0.9, 4, 110, 110, 200, 200, 0.8, 5]),
    [1, 2, 6],
    custom,
    letterbox(320, 320, 320),
  );
  expect(detections.map((d) => d.className)).toEqual(["bus", "truck"]);
  expect(validateManifest(custom).classCount).toBe(6);
});
test("B04 raw decoder has class scores without separate objectness and class-aware NMS", () => {
  const custom: ModelManifest = {
    ...manifest,
    classCount: 6,
    classMap: {
      0: "person",
      1: "bicycle",
      2: "car",
      3: "motorcycle",
      4: "bus",
      5: "truck",
    },
    output: {
      ...manifest.output,
      format: "yolo_raw_xywh_class_scores",
      shape: [1, 10, 3],
    },
  };
  const raw = new Float32Array(30);
  for (let i = 0; i < 3; i++) {
    raw[i] = 160;
    raw[3 + i] = 160;
    raw[6 + i] = 100;
    raw[9 + i] = 100;
  }
  raw[12] = 0.9;
  raw[13] = 0.8;
  raw[29] = 0.7;
  const detections = decode(raw, [1, 10, 3], custom, letterbox(320, 320, 320));
  expect(detections).toHaveLength(2);
  expect(detections.map((d) => d.className)).toEqual(["person", "truck"]);
  expect(detections[0]!.score).toBeCloseTo(0.9);
});
test("B04 RGB layout padding and coordinate inversion are deterministic", () => {
  const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]);
  const { tensor, info } = preprocessRgba(pixels, 2, 1, 320);
  expect(info.top).toBe(80);
  expect(tensor[0]).toBeCloseTo(114 / 255);
  expect(tensor[80 * 320]).toBe(1);
  expect(tensor[2 * 320 * 320 + 80 * 320 + 319]).toBe(1);
  expect(invertBox([0, 80, 320, 240], info)).toEqual([0, 0, 1, 1]);
  expect(invertBox([0, 0, 1, 0], info)).toBeNull();
});
test("B04 unknown formats, dimensions, malformed boxes fail safely", () => {
  expect(() =>
    validateManifest({
      ...manifest,
      output: { ...manifest.output, format: "guessed" },
    }),
  ).toThrow("Unsupported model output");
  expect(() =>
    decode(new Float32Array(2), [1, 2], manifest, letterbox(320, 320, 320)),
  ).toThrow("shape");
  expect(() => letterbox(0, 10, 320)).toThrow();
  expect(() => letterbox(5000, 5000, 320)).toThrow();
  const malformed = {
    ...manifest,
    output: { ...manifest.output, shape: [1, 1, 6] },
  };
  expect(
    decode(
      new Float32Array([NaN, 0, 30, 30, 0.9, 0]),
      [1, 1, 6],
      malformed,
      letterbox(320, 320, 320),
    ),
  ).toEqual([]);
});
