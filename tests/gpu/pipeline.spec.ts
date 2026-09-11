import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { decodeGpuFrame, GpuResultSchema } from "../../shared/src/gpu";

const origin = "http://127.0.0.1:10006";
const secret = randomBytes(32).toString("base64url");
let relay: ChildProcess, worker: ChildProcess;
const workerOutput: string[] = [];
async function terminate(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);
}
async function startRelay() {
  relay = spawn(process.execPath, ["dist/backend/src/main.js"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: "10006",
      SERVE_WEB: "true",
      ALLOWED_ORIGINS: origin,
      ROADLENS_WORKER_SECRET: secret,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(origin + "/healthz")).ok;
        } catch {
          return false;
        }
      },
      { timeout: 10000 },
    )
    .toBe(true);
}
function startWorker() {
  worker = spawn("worker/.venv/Scripts/python.exe", ["-m", "worker.main"], {
    env: {
      ...process.env,
      ROADLENS_RELAY_URL: "ws://127.0.0.1:10006/worker",
      ROADLENS_ALLOW_LOOPBACK: "true",
      ROADLENS_WORKER_SECRET: secret,
      ROADLENS_MODEL_MODE: "balanced",
      ROADLENS_GPU_RUNTIME:
        process.env.ROADLENS_GPU_TEST_RUNTIME ?? "pytorch_cuda",
      ALLOW_WORKER_CPU_FALLBACK: "false",
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const output of [worker.stdout, worker.stderr])
    output?.on("data", (data) => {
      workerOutput.push(String(data));
      if (workerOutput.length > 32) workerOutput.shift();
    });
}
async function ready() {
  await expect
    .poll(
      async () => {
        try {
          const r = await fetch(origin + "/api/config", {
            headers: { Origin: origin },
          });
          return (await r.json()).gpu?.state;
        } catch {
          return "offline";
        }
      },
      { timeout: 60000 },
    )
    .toBe("ready");
}
test.beforeAll(async () => {
  await startRelay();
  startWorker();
  await ready();
});
test.afterAll(async () => {
  await terminate(worker);
  await terminate(relay);
  expect(workerOutput.join("")).not.toContain(secret);
});

async function replay(page: Page) {
  await page.goto("/camera");
  // Permitted photograph encoded to replay in RAM. This is not field-motion evidence.
  const bytes = await page.evaluate(async () => {
    const image = await createImageBitmap(
      await (await fetch("/demo/bus.png")).blob(),
    );
    const canvas = document.createElement("canvas");
    canvas.width = 810;
    canvas.height = 1080;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0, 810, 1080);
    const stream = canvas.captureStream(15);
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
      videoBitsPerSecond: 2000000,
    });
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const ended = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start();
    const timer = setInterval(() => ctx.drawImage(image, 0, 0, 810, 1080), 60);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    recorder.stop();
    await ended;
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    image.close();
    return Array.from(
      new Uint8Array(
        await new Blob(chunks, { type: "video/webm" }).arrayBuffer(),
      ),
    );
  });
  await page.locator("video").evaluate((e) => {
    (e as HTMLVideoElement).loop = true;
  });
  await page.getByLabel("Choose replay video").setInputFiles({
    name: "permitted-photo-gpu-replay.webm",
    mimeType: "video/webm",
    buffer: Buffer.from(bytes),
  });
}
test("real GPU camera → relay → CUDA → synchronized reports/viewer; fallback, reconnect and relay restart", async ({
  browser,
  page,
}) => {
  const errors: string[] = [];
  const restartNetworkErrors: string[] = [];
  let restartingRelay = false;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") {
      if (
        restartingRelay &&
        /net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE)/.test(
          m.text(),
        )
      )
        restartNetworkErrors.push(m.text());
      else errors.push(m.text() + " " + m.location().url);
    }
  });
  const submitted = new Map<
    string,
    { sent: number; bytes: number; edge: number }
  >();
  const observations: {
    edge: number;
    bytes: number;
    age: number;
    inferenceMs: number;
    totalMs: number;
    detections: number;
  }[] = [];
  const completedIds = new Set<string>();
  const rates: { edge: number; values: Record<string, string | undefined> }[] =
    [];
  const gpuMessages: { type: string; state?: string; code?: string }[] = [];
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/gpu") return;
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string") return;
      const { header } = decodeGpuFrame(new Uint8Array(payload));
      expect(submitted.size).toBeLessThan(2);
      submitted.set(header.frameId, {
        sent: performance.now(),
        bytes: payload.length,
        edge: Math.max(header.encodedWidth, header.encodedHeight),
      });
    });
    socket.on("framereceived", ({ payload }) => {
      const incoming = JSON.parse(String(payload));
      if (incoming.type === "inference.error")
        submitted.delete(incoming.frameId);
      if (incoming.type !== "inference.result")
        gpuMessages.push({
          type: incoming.type,
          state: incoming.state,
          code: incoming.code,
        });
      const parsed = GpuResultSchema.safeParse(JSON.parse(String(payload)));
      if (!parsed.success) return;
      const r = parsed.data,
        sent = submitted.get(r.frameId);
      expect(sent).toBeTruthy();
      if (!sent) return;
      completedIds.add(r.frameId);
      submitted.delete(r.frameId);
      observations.push({
        edge: sent.edge,
        bytes: sent.bytes,
        age: performance.now() - sent.sent,
        inferenceMs: r.metrics.inferenceMs,
        totalMs: r.metrics.totalMs,
        detections: r.detections.length,
      });
    });
    socket.on("close", () => submitted.clear());
  });
  await replay(page);
  const analyzed = page.getByTestId("analyzed-frame");
  await expect(page.getByTestId("inference-mode")).toContainText(
    "GPU AI · Online",
  );
  await expect(analyzed).toHaveAttribute(
    "data-provider",
    /pytorch_cuda|onnx_cuda|tensorrt/,
  );
  await expect(analyzed).toHaveAttribute(
    "aria-label",
    /[1-9]\d* observed objects/,
  );
  await expect
    .poll(() => observations.filter((r) => r.edge === 640).length)
    .toBeGreaterThanOrEqual(20);
  const rendered = await analyzed.getAttribute("data-frame-id");
  expect(
    completedIds.has(rendered!),
    JSON.stringify({
      rendered,
      provider: await analyzed.getAttribute("data-provider"),
      gpuMessages,
    }),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Save observation", exact: true })
    .click();
  const code = (await page.getByTestId("pairing-code").innerText()).trim();
  const viewer = await browser.newContext({ baseURL: origin });
  const view = await viewer.newPage();
  let viewerModel = false;
  view.on("request", (r) => {
    if (/\.onnx|\/ort\//.test(r.url())) viewerModel = true;
  });
  await view.goto("/viewer");
  await view.getByLabel("Camera code").fill(code);
  await view.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(view.getByTestId("analyzed-frame")).toHaveAttribute(
    "data-provider",
    /pytorch_cuda|onnx_cuda|tensorrt/,
  );
  await view.locator(".report-row").first().click();
  await expect(
    view.getByRole("button", { name: "Mark noted", exact: true }).first(),
  ).toBeVisible();
  await view
    .getByRole("button", { name: "Mark noted", exact: true })
    .first()
    .click();
  await expect(view.locator(".report-row").first()).toContainText(/noted/i);
  await view.getByRole("button", { name: "Close drawer", exact: true }).click();
  expect(viewerModel).toBe(false);
  const gpuEpoch = (await analyzed.getAttribute("data-frame-id"))!.split(
    ":",
  )[0];
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  rates.push({
    edge: 640,
    values: await page
      .getByTestId("gpu-diagnostics")
      .evaluate((e) => ({ ...(e as HTMLElement).dataset })),
  });
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page.getByRole("button", { name: "Pause camera", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("GPU analysis image").selectOption("960");
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await ready();
  await page
    .getByRole("button", { name: "Resume camera", exact: true })
    .click();
  await expect(analyzed).toHaveAttribute(
    "data-provider",
    /pytorch_cuda|onnx_cuda|tensorrt/,
  );
  await expect
    .poll(() => observations.filter((r) => r.edge === 960).length)
    .toBeGreaterThanOrEqual(20);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  rates.push({
    edge: 960,
    values: await page
      .getByTestId("gpu-diagnostics")
      .evaluate((e) => ({ ...(e as HTMLElement).dataset })),
  });
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  expect(
    (await analyzed.getAttribute("data-frame-id"))!.split(":")[0],
  ).not.toBe(gpuEpoch);
  await page
    .getByRole("button", { name: "Save observation", exact: true })
    .click();
  // A real worker process stops. Browser fallback must really load and run ONNX.
  const lastGpuEpoch = (await analyzed.getAttribute("data-frame-id"))!.split(
    ":",
  )[0];
  await terminate(worker);
  await expect(analyzed).toHaveAttribute("data-provider", "wasm", {
    timeout: 30000,
  });
  expect(
    (await analyzed.getAttribute("data-frame-id"))!.split(":")[0],
  ).not.toBe(lastGpuEpoch);
  await expect(page.getByTestId("inference-mode")).toContainText("Browser");
  await page
    .getByRole("button", { name: "Save observation", exact: true })
    .click();
  // Restart the actual worker, then explicitly opt back into GPU: no trajectory merge.
  startWorker();
  await ready();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Use GPU worker", exact: true })
    .click();
  await expect(page.getByTestId("inference-mode")).toContainText(
    "GPU AI · Online",
  );
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await expect(analyzed).toHaveAttribute(
    "data-provider",
    /pytorch_cuda|onnx_cuda|tensorrt/,
  );
  await page.screenshot({
    path: "docs/evidence/gpu-mobile.png",
    mask: [page.getByTestId("pairing-code")],
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "docs/evidence/gpu-desktop.png",
    mask: [page.getByTestId("pairing-code")],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  // Actual relay process restart invalidates rooms while worker reconnects outbound.
  restartingRelay = true;
  await terminate(relay);
  await startRelay();
  await ready();
  // This combined-server harness also interrupts static assets. A failed fallback
  // load must pause visibly, preserve reports and recover with an explicit Resume.
  await expect
    .poll(
      async () =>
        (await analyzed
          .getAttribute("data-provider", { timeout: 100 })
          .catch(() => null)) === "wasm" ||
        (await page
          .getByRole("button", { name: "Resume camera", exact: true })
          .isVisible()),
    )
    .toBe(true);
  if (
    await page
      .getByRole("button", { name: "Resume camera", exact: true })
      .isVisible()
  ) {
    await expect(page.getByRole("alert")).toContainText(
      "Browser fallback unavailable",
    );
    await expect(page.locator(".report-row")).toHaveCount(3);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Prefer available GPU on start").uncheck();
    await page
      .getByRole("button", { name: "Close drawer", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Resume camera", exact: true })
      .click();
  }
  await expect(analyzed).toHaveAttribute("data-provider", "wasm", {
    timeout: 30000,
  });
  await expect(view.getByTestId("analyzed-frame")).not.toBeVisible();
  await expect(page.locator(".page-heading")).toContainText("Pairing expired");
  await expect(page.getByTestId("pairing-code")).not.toBeVisible();
  restartingRelay = false;
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await page
    .getByRole("button", { name: "End and clear session", exact: true })
    .click();
  await expect(analyzed).not.toBeVisible();
  await expect(page.locator(".report-row")).toHaveCount(0);
  expect(
    await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      dbs: (await indexedDB.databases()).length,
      caches: (await caches.keys()).length,
    })),
  ).toEqual({ local: 0, session: 0, dbs: 0, caches: 0 });
  expect(errors).toEqual([]);
  await viewer.close();
  await mkdir("docs/evidence", { recursive: true });
  const summary = [640, 960].map((edge) => {
    const rows = observations.filter((r) => r.edge === edge);
    const mean = (key: keyof (typeof rows)[number]) =>
      rows.reduce((a, b) => a + b[key], 0) / rows.length;
    return {
      edge,
      frames: rows.length,
      meanBytes: mean("bytes"),
      meanResultRoundTripMs: mean("age"),
      meanInferenceMs: mean("inferenceMs"),
      meanWorkerMs: mean("totalMs"),
      minDetections: Math.min(...rows.map((r) => r.detections)),
    };
  });
  await writeFile(
    "docs/evidence/gpu-browser-pipeline.json",
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        fixture:
          "permitted still-photo replay, not physical phone or field accuracy",
        transport: "local loopback WS",
        runtime: process.env.ROADLENS_GPU_TEST_RUNTIME ?? "pytorch_cuda",
        summary,
        cameraClockRates: rates,
        expectedRestartNetworkErrors: restartNetworkErrors.length,
      },
      null,
      2,
    ),
  );
});
