/**
 * Measures the real camera → relay → CUDA worker → camera path with the actual
 * browser page, the actual relay process and the actual local GPU worker.
 *
 * Network latency is injected inside the page's /gpu WebSocket only, so a
 * hosted-relay round trip can be emulated without touching the relay, the
 * worker, or any measurement code. Nothing here changes application behaviour.
 *
 *   node scripts/benchmark-pipeline.mjs --latency 0,60,120 --edge 640 --seconds 20
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const latencies = (args.get("latency") ?? "0,60,120")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0);
const edge = Number(args.get("edge") ?? 640);
const seconds = Number(args.get("seconds") ?? 20);
const out = args.get("out") ?? "docs/evidence/pipeline-benchmark.json";
const port = Number(args.get("port") ?? 10007);
const origin = `http://127.0.0.1:${port}`;
const secret = randomBytes(32).toString("base64url");

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(check, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(everyMs);
  }
  throw new Error("Timed out waiting for the pipeline");
}
async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(3000),
  ]);
}

const relay = spawn(process.execPath, ["dist/backend/src/main.js"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    SERVE_WEB: "true",
    ALLOWED_ORIGINS: origin,
    ROADLENS_WORKER_SECRET: secret,
  },
  stdio: "ignore",
  windowsHide: true,
});
const worker = spawn("worker/.venv/Scripts/python.exe", ["-m", "worker.main"], {
  env: {
    ...process.env,
    ROADLENS_RELAY_URL: `ws://127.0.0.1:${port}/worker`,
    ROADLENS_ALLOW_LOOPBACK: "true",
    ROADLENS_WORKER_SECRET: secret,
    ROADLENS_MODEL_MODE: process.env.ROADLENS_MODEL_MODE ?? "balanced",
    ROADLENS_GPU_RUNTIME: process.env.ROADLENS_GPU_RUNTIME ?? "pytorch_cuda",
    ALLOW_WORKER_CPU_FALLBACK: "false",
    PYTHONUNBUFFERED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const workerLog = [];
for (const stream of [worker.stdout, worker.stderr])
  stream?.on("data", (data) => {
    const text = String(data);
    workerLog.push(text);
    if (workerLog.length > 200) workerLog.shift();
    if (/error|traceback|not ready/i.test(text)) process.stderr.write(text);
  });
// A worker that exits during startup must fail the run loudly, not silently
// stall the readiness poll until its timeout.
let workerExit = null;
worker.on("exit", (code, signal) => {
  workerExit = `GPU worker exited early (code ${code}, signal ${signal}).
${workerLog.join("")}`;
});

const runs = [];
let encoding = null;
try {
  await poll(async () => {
    if (workerExit) throw new Error(workerExit);
    try {
      const response = await fetch(origin + "/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ v: 2 }),
      });
      return (await response.json()).gpu?.state === "ready";
    } catch {
      return false;
    }
  }, 120_000);
  console.log(
    "GPU worker ready. Measuring",
    latencies.length,
    "configurations",
  );

  for (const latency of latencies) {
    const browser = await chromium.launch({
      channel: "chromium",
      headless: true,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    });
    const context = await browser.newContext({
      baseURL: origin,
      permissions: ["camera"],
      viewport: { width: 390, height: 844 },
    });
    // Emulate a hosted round trip: half the latency each way on /gpu only.
    await context.addInitScript(`(() => {
      const added = ${latency};
      if (!added) return;
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url, protocols) {
          super(url, protocols);
          if (!/\\/gpu(\\?|$)/.test(String(url))) return;
          const delay = added / 2;
          const send = Original.prototype.send.bind(this);
          this.send = (data) =>
            setTimeout(() => {
              if (this.readyState === 1) send(data);
            }, delay);
          Object.defineProperty(this, "onmessage", {
            configurable: true,
            set(handler) {
              Original.prototype.__lookupSetter__("onmessage").call(
                this,
                (event) => setTimeout(() => handler(event), delay),
              );
            },
          });
        }
      };
    })()`);
    const page = await context.newPage();
    const samples = [];
    let pictureHz = 0;
    try {
      await page.goto("/camera");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByLabel("GPU analysis image").selectOption(String(edge));
      await page.getByRole("button", { name: "Close drawer" }).click();
      await page
        .getByRole("button", { name: "Start camera", exact: true })
        .click();
      const analyzed = page.getByTestId("analyzed-frame");
      await poll(
        async () =>
          /cuda|tensorrt/.test(
            (await analyzed.getAttribute("data-provider")) ?? "",
          ),
        90_000,
      );
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      // The collapsed diagnostics block only exists in the current build.
      await page
        .locator("details.diagnostics > summary")
        .click({ timeout: 2000 })
        .catch(() => {});
      // Analysed-picture refresh rate, measured identically on either build.
      await page.evaluate(() => {
        window.__pictureUpdates = [];
        const target = document.querySelector('[data-testid="analyzed-frame"]');
        if (!target) return;
        new MutationObserver(() =>
          window.__pictureUpdates.push(performance.now()),
        ).observe(target, {
          attributes: true,
          attributeFilter: ["data-frame-id"],
        });
      });
      // Let the adaptive controller settle before recording.
      await wait(4000);
      const until = Date.now() + seconds * 1000;
      while (Date.now() < until) {
        samples.push(
          await page.evaluate(() => {
            const read = (id) => ({
              ...document.querySelector(`[data-testid="${id}"]`)?.dataset,
            });
            return {
              at: Date.now(),
              capture: read("capture-diagnostics"),
              gpu: read("gpu-diagnostics"),
              performance: read("performance-summary"),
            };
          }),
        );
        await wait(500);
      }
      const updates = await page.evaluate(() => window.__pictureUpdates ?? []);
      pictureHz =
        updates.length > 1
          ? ((updates.length - 1) * 1000) / (updates.at(-1) - updates[0])
          : 0;
      if (!encoding)
        encoding = await page.evaluate(async () => {
          const video = document.querySelector("video");
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 480;
          canvas.getContext("2d").drawImage(video, 0, 0);
          const measure = async (type, quality) => {
            const times = [];
            let bytes = 0;
            for (let i = 0; i < 12; i++) {
              const started = performance.now();
              const blob = await new Promise((resolve) =>
                canvas.toBlob(resolve, type, quality),
              );
              times.push(performance.now() - started);
              bytes = blob ? blob.size : 0;
            }
            times.sort((a, b) => a - b);
            return { type, quality, medianMs: times[times.length >> 1], bytes };
          };
          return {
            width: canvas.width,
            height: canvas.height,
            jpeg: await measure("image/jpeg", 0.75),
            webp: await measure("image/webp", 0.75),
          };
        });
    } finally {
      await context.close();
      await browser.close();
    }
    const numbers = (group, key) =>
      samples
        .map((sample) => Number(sample[group]?.[key]))
        .filter((value) => Number.isFinite(value) && value > 0);
    const last = samples.at(-1) ?? {};
    runs.push({
      addedLatencyMs: latency,
      edge,
      samples: samples.length,
      cameraFps: median(numbers("capture", "sourceHz")),
      acceptedFps: median(numbers("capture", "acceptedHz")),
      analysisFps: median(numbers("capture", "analysisHz")),
      displayHz: median(numbers("performance", "displayHz")),
      analysedPictureHz: pictureHz,
      overlayAgeMs: median(numbers("performance", "overlayAgeMs")),
      submittedHz: median(numbers("gpu", "submittedHz")),
      resultHz: median(numbers("gpu", "resultHz")),
      resultAgeMs: median(numbers("gpu", "resultAgeMs")),
      rttMs: median(numbers("gpu", "rttMs")),
      maxInFlight: Number(last.capture?.maxInFlight ?? 0),
      medianInFlight: median(numbers("capture", "inFlight")),
      // Correctness counters: a completion dropped because a newer frame had
      // already committed, or because it exceeded the result-age ceiling.
      supersededResults: Number(last.capture?.superseded ?? 0),
      staleResults: Number(last.capture?.stale ?? 0),
      encodeMs: median(numbers("gpu", "encodeMs")),
      processingMs: median(numbers("gpu", "processingMs")),
      trackingMs: median(numbers("gpu", "trackingMs")),
      workerTotalMs: median(numbers("gpu", "workerTotalMs")),
      gpuInferenceMs: median(numbers("gpu", "gpuInferenceMs")),
      timingSource: last.capture?.timingSource ?? null,
      scheduler: last.capture?.scheduler ?? null,
    });
    console.log(JSON.stringify(runs.at(-1)));
  }
} finally {
  await terminate(worker);
  await terminate(relay);
}
const artifact = {
  measuredAt: new Date().toISOString(),
  note: "Local relay, real CUDA worker, Chromium synthetic camera. Injected latency emulates a hosted round trip; it is not a physical-phone measurement.",
  modelMode: process.env.ROADLENS_MODEL_MODE ?? "balanced",
  runtime: process.env.ROADLENS_GPU_RUNTIME ?? "pytorch_cuda",
  runs,
  encoding,
};
await mkdir(out.replace(/[^/\\]+$/, ""), { recursive: true });
await writeFile(out, JSON.stringify(artifact, null, 2));
console.log("Wrote", out);
