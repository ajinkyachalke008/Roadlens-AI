import * as ort from "onnxruntime-web/wasm";
import { decode } from "./decode";
import { preprocessRgba } from "./preprocess";
import { validateManifest, verifyIntegrity } from "./manifest";
import type { ModelManifest } from "./types";
let session: ort.InferenceSession | null = null;
let manifest: ModelManifest | null = null;
let busy = false;
async function load(base: string, profile: 416 | 320, id: number) {
  if (session) {
    await session.release();
    session = null;
  }
  const response = await fetch(new URL(`models/yolo26n-${profile}.json`, base));
  if (!response.ok) throw new Error("Model manifest unavailable");
  manifest = validateManifest(await response.json());
  if (manifest.profile !== profile)
    throw new Error("Model manifest profile mismatch");
  if (manifest.runtimeVersion !== ort.env.versions.web)
    throw new Error("ORT runtime version differs from model validation");
  const model = await fetch(new URL(`models/${manifest.file}`, base));
  if (!model.ok || !model.body) throw new Error("Model download failed");
  const reader = model.body.getReader(),
    buffer = new Uint8Array(manifest.bytes);
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.length > buffer.length)
        throw new Error("Model exceeds manifest byte limit");
      buffer.set(value, loaded);
      loaded += value.length;
      self.postMessage({
        type: "progress",
        id,
        progress: { stage: "download", loaded, total: buffer.length },
      });
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  await verifyIntegrity(buffer.buffer, manifest);
  self.postMessage({
    type: "progress",
    id,
    progress: { stage: "initialize", loaded, total: buffer.length },
  });
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = new URL("ort/", base).href;
  session = await ort.InferenceSession.create(buffer, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  if (
    session.inputNames.length !== 1 ||
    session.inputNames[0] !== manifest.input.name ||
    session.outputNames.length !== 1 ||
    session.outputNames[0] !== manifest.output.name
  ) {
    await session.release();
    session = null;
    throw new Error("Model tensor names do not match manifest");
  }
}
self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  if (busy) {
    message.bitmap?.close();
    self.postMessage({
      id: message.id,
      type: "error",
      message: "Inference worker is busy",
    });
    return;
  }
  busy = true;
  try {
    if (message.type === "load") {
      await load(message.base, message.profile, message.id);
      self.postMessage({ id: message.id, type: "ready" });
    } else if (message.type === "detect") {
      if (!session || !manifest) throw new Error("Detector is not loaded");
      const started = performance.now();
      let rgba: Uint8ClampedArray;
      let width: number;
      let height: number;
      if (message.bitmap) {
        const bitmap: ImageBitmap = message.bitmap;
        width = bitmap.width;
        height = bitmap.height;
        if (width * height > 16777216)
          throw new Error("Source exceeds pixel limit");
        const canvas = new OffscreenCanvas(width, height),
          ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Canvas is unavailable");
        ctx.drawImage(bitmap, 0, 0);
        rgba = ctx.getImageData(0, 0, width, height).data;
        canvas.width = 1;
        canvas.height = 1;
      } else {
        width = message.width;
        height = message.height;
        rgba = new Uint8ClampedArray(message.rgba);
      }
      const { tensor, info } = preprocessRgba(
        rgba,
        width,
        height,
        manifest.profile,
      );
      const input = new ort.Tensor("float32", tensor, manifest.input.shape);
      let outputs: ort.InferenceSession.OnnxValueMapType | undefined;
      try {
        outputs = await session.run({ [manifest.input.name]: input });
        const output = outputs[manifest.output.name];
        if (!output || output.type !== "float32")
          throw new Error("Unexpected output dtype");
        const detections = decode(
          output.data as Float32Array,
          output.dims,
          manifest,
          info,
        );
        self.postMessage({
          id: message.id,
          type: "result",
          result: {
            detections,
            inferenceMs: performance.now() - started,
            modelId: manifest.id,
            modelSha256: manifest.sha256,
            profile: manifest.profile,
            executionProvider: "wasm",
          },
        });
      } finally {
        input.dispose();
        if (outputs)
          for (const value of Object.values(outputs)) value.dispose();
      }
    } else if (message.type === "dispose") {
      if (session) await session.release();
      session = null;
      manifest = null;
      self.postMessage({ id: message.id, type: "disposed" });
    } else throw new Error("Unknown detector operation");
  } catch (error) {
    self.postMessage({
      id: message.id,
      type: "error",
      message: error instanceof Error ? error.message : "Detector failed",
    });
  } finally {
    message.bitmap?.close();
    busy = false;
  }
};
