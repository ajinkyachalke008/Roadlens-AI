import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs";
import type { DetectionResult } from "../../frontend/src/inference/types";
test("B05 production bundled worker loads matching public WASM and real model", async ({
  page,
}) => {
  const worker = readdirSync("tests/model/dist/assets").find((name) =>
    /^worker-.*\.js$/.test(name),
  );
  expect(worker).toBeTruthy();
  await page.route("http://127.0.0.1:5176/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Production model smoke</title>",
    }),
  );
  await page.goto("http://127.0.0.1:5176/");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const result = await page.evaluate(async (name) => {
    const instance = new Worker(`/assets/${name}`, { type: "module" });
    const response = new Promise<DetectionResult>((resolve, reject) => {
      instance.onerror = () => reject(new Error("Production worker failed"));
      instance.onmessage = async (event) => {
        const message = event.data;
        if (message.type === "error") reject(new Error(message.message));
        if (message.type === "ready") {
          const image = await createImageBitmap(
            await (await fetch("/demo/bus.png")).blob(),
          );
          instance.postMessage({ type: "detect", id: 2, bitmap: image }, [
            image,
          ]);
        }
        if (message.type === "result") resolve(message.result);
      };
    });
    instance.postMessage({
      type: "load",
      id: 1,
      base: location.origin + "/",
      profile: 416,
    });
    try {
      return await response;
    } finally {
      instance.terminate();
    }
  }, worker!);
  expect(result.executionProvider).toBe("wasm");
  expect(result.detections.some((d) => d.className === "bus")).toBe(true);
  expect(errors).toEqual([]);
  const wasm = await page.request.get(
    "http://127.0.0.1:5176/ort/ort-wasm-simd-threaded.wasm",
  );
  expect(wasm.headers()["content-type"]).toContain("application/wasm");
  const model = await page.request.get(
    "http://127.0.0.1:5176/models/yolo26n-416.onnx",
  );
  expect((await model.body()).length).toBe(9796924);
});
