import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { decode, iou } from "../../frontend/src/inference/decode";
import type { ModelManifest } from "../../frontend/src/inference/types";
const measurements: unknown[] = [];
test.beforeEach(async ({ page }) => {
  await page.route("http://127.0.0.1:5175/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>RoadLens model verification</title>",
    }),
  );
});
for (const side of [416, 320] as const)
  for (const name of ["bus", "bus-landscape"]) {
    test(`B04 real worker WASM ${side} ${name} matches Python ONNX`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("/");
      const observed = await page.evaluate(
        async ({ side, name }) => {
          // Test imports the real app client, creates its real worker and public model assets.
          const entry = "/src/inference/client.ts";
          const { DetectorClient } = (await import(
            entry
          )) as typeof import("../../frontend/src/inference/client");
          const client = new DetectorClient();
          const started = performance.now();
          await client.load(side);
          const image = await createImageBitmap(
            await (await fetch(`/demo/${name}.png`)).blob(),
          );
          const result = await client.detect(image);
          client.dispose();
          return { ...result, loadAndInferenceMs: performance.now() - started };
        },
        { side, name },
      );
      const manifest = JSON.parse(
        readFileSync(`frontend/public/models/yolo26n-${side}.json`, "utf8"),
      ) as ModelManifest;
      const reference = JSON.parse(
        readFileSync(`tests/fixtures/${name}-${side}-reference.json`, "utf8"),
      );
      const expected = decode(
        new Float32Array(reference.output),
        reference.shape,
        manifest,
        reference.letterbox,
      );
      expect(expected.length).toBeGreaterThan(0);
      expect(observed.detections.length).toBe(expected.length);
      for (const target of expected) {
        const match = observed.detections.find(
          (d) =>
            d.className === target.className && iou(d.bbox, target.bbox) > 0.99,
        );
        expect(match, JSON.stringify(target)).toBeTruthy();
        expect(Math.abs(match!.score - target.score)).toBeLessThan(0.001);
      }
      expect(observed.executionProvider).toBe("wasm");
      expect(errors).toEqual([]);
      measurements.push({
        name,
        side,
        detections: observed.detections.length,
        inferenceMs: observed.inferenceMs,
        loadAndInferenceMs: observed.loadAndInferenceMs,
      });
    });
  }
test("B05 corrupted model hash fails visibly before inference", async ({
  page,
}) => {
  await page.route("**/models/yolo26n-416.onnx", async (route) => {
    const response = await route.fetch();
    const bytes = await response.body();
    bytes[100] ^= 1;
    await route.fulfill({ response, body: bytes });
  });
  await page.goto("/");
  const error = await page.evaluate(async () => {
    const entry = "/src/inference/client.ts";
    const { DetectorClient } = (await import(
      entry
    )) as typeof import("../../frontend/src/inference/client");
    const client = new DetectorClient();
    try {
      await client.load(416);
      return "unexpected success";
    } catch (e) {
      return String(e);
    } finally {
      client.dispose();
    }
  });
  expect(error).toContain("Model integrity mismatch");
});
test("B05 one active inference and one latest pending frame; disposal and reload", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const entry = "/src/inference/client.ts";
    const { DetectorClient } = (await import(
      entry
    )) as typeof import("../../frontend/src/inference/client");
    const client = new DetectorClient();
    await client.load(320);
    const blob = await (await fetch("/demo/bus.png")).blob();
    const images = await Promise.all([
      createImageBitmap(blob),
      createImageBitmap(blob),
      createImageBitmap(blob),
    ]);
    const first = client.detect(images[0]!);
    const second = client.detect(images[1]!).catch((e) => String(e));
    const third = client.detect(images[2]!);
    const results = await Promise.all([first, second, third]);
    await client.load(416);
    const reloaded = await client.detect(await createImageBitmap(blob));
    client.dispose();
    const after = await client
      .detect(await createImageBitmap(blob))
      .catch((e) => String(e));
    return {
      first: typeof results[0],
      second: results[1],
      third: typeof results[2],
      reloaded: reloaded.profile,
      after,
    };
  });
  expect(result.first).toBe("object");
  expect(result.second).toContain("Newer frame");
  expect(result.third).toBe("object");
  expect(result.reloaded).toBe(416);
  expect(result.after).toContain("not loaded");
});
test.afterAll(() => {
  writeFileSync(
    "tests/model/browser-results.json",
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        browser: "Playwright Chromium desktop",
        executionProvider: "wasm",
        numThreads: 1,
        measurements,
      },
      null,
      2,
    ) + "\n",
  );
});
