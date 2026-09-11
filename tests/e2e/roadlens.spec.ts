import {
  test,
  expect,
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Download,
} from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { decodePacket } from "../../shared/src/packets";
import type { PacketHeader } from "../../shared/src/schemas";
import { localTlsAllowed } from "./localTls";

test("GPU preparation privacy: delayed status cannot resume after Pause or hidden-page loss", async ({
  browser,
}) => {
  const { context, page, errors } = await pageFor(browser);
  await startReplay(page);
  for (const action of ["pause", "hidden"] as const) {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/config", async (route) => {
      const response = await route.fetch();
      entered();
      await held;
      await route.fulfill({ response });
    });
    await page
      .getByLabel("Choose replay video")
      .setInputFiles({
        name: "permitted-bus-still-photo.webm",
        mimeType: "video/webm",
        buffer: replay,
      });
    await waiting;
    if (action === "pause")
      await page
        .getByRole("button", { name: "Pause camera", exact: true })
        .click();
    else
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    release();
    await expect(
      page.getByRole("button", { name: "Resume camera", exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(1800);
    expect(
      await page
        .locator("video")
        .evaluate((e) => (e as HTMLVideoElement).paused),
    ).toBe(true);
    await expect(page.getByTestId("analyzed-frame")).not.toBeVisible();
    await page.unroute("**/api/config");
    if (action === "hidden")
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => false,
        });
      });
    else {
      await page
        .getByRole("button", { name: "Resume camera", exact: true })
        .click();
      await expect(page.getByTestId("analyzed-frame")).toBeVisible();
    }
  }
  expect(errors).toEqual([]);
  await boundedPrivacy(page);
  await context.close();
});

type Trace = {
  writes: string[];
  media: MediaStreamConstraints[];
  workersCreated: number;
  workersEnded: number;
  tracksStopped: number;
  urls: number;
  drawings: {
    frameId: string;
    width: number;
    height: number;
    pixels: number[];
    boxes: number[][];
  }[];
};
declare global {
  interface Window {
    __roadlensTest: Trace;
    __roadlensSockets: WebSocket[];
  }
}
let replay: Buffer;
let fakeCameraImage: Buffer;
let roomAttempts: number[] = [];
const base = process.env.ROADLENS_BASE_URL ?? "http://127.0.0.1:5173";

async function instrument(context: BrowserContext) {
  await context.addInitScript(() => {
    const trace: Trace = {
      writes: [],
      media: [],
      workersCreated: 0,
      workersEnded: 0,
      tracksStopped: 0,
      urls: 0,
      drawings: [],
    };
    window.__roadlensTest = trace;
    window.__roadlensSockets = [];
    const OriginalSocket = window.WebSocket;
    window.WebSocket = class extends OriginalSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        window.__roadlensSockets.push(this);
      }
    };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (...args) {
      trace.writes.push("web-storage");
      return setItem.apply(this, args);
    };
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      trace.writes.push("indexed-db");
      return open.apply(this, args);
    };
    if ("caches" in window) {
      const openCache = CacheStorage.prototype.open;
      CacheStorage.prototype.open = function (...args) {
        trace.writes.push("cache-storage");
        return openCache.apply(this, args);
      };
    }
    if (navigator.mediaDevices) {
      const media = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = (constraints) => {
        trace.media.push(constraints ?? {});
        return media(constraints);
      };
    }
    const stopTrack = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () {
      trace.tracksStopped++;
      stopTrack.call(this);
    };
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        trace.workersCreated++;
      }
      terminate() {
        trace.workersEnded++;
        super.terminate();
      }
    };
    const create = URL.createObjectURL,
      revoke = URL.revokeObjectURL;
    URL.createObjectURL = function (blob) {
      trace.urls++;
      return create.call(this, blob);
    };
    URL.revokeObjectURL = function (url) {
      trace.urls--;
      revoke.call(this, url);
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = new Proxy(draw, {
      apply(target, context: CanvasRenderingContext2D, args) {
        Reflect.apply(target, context, args);
        const id = context.canvas.dataset.frameId;
        if (!id) return;
        const pixels: number[] = [];
        for (const [x, y] of [
          [0.1, 0.1],
          [0.4, 0.3],
          [0.5, 0.5],
          [0.7, 0.7],
          [0.9, 0.9],
        ])
          pixels.push(
            ...context.getImageData(
              Math.floor(x * context.canvas.width),
              Math.floor(y * context.canvas.height),
              1,
              1,
            ).data,
          );
        trace.drawings.push({
          frameId: id,
          width: context.canvas.width,
          height: context.canvas.height,
          pixels,
          boxes: [],
        });
        if (trace.drawings.length > 64) trace.drawings.shift();
      },
    });
    const stroke = CanvasRenderingContext2D.prototype.strokeRect;
    CanvasRenderingContext2D.prototype.strokeRect = function (...args) {
      if (this.canvas.dataset.frameId) trace.drawings.at(-1)?.boxes.push(args);
      stroke.apply(this, args);
    };
  });
}
async function pageFor(
  browser: Browser,
  viewport = { width: 1440, height: 1000 },
) {
  const context = await browser.newContext({
    viewport,
    baseURL: base,
    ignoreHTTPSErrors: localTlsAllowed(),
  });
  await instrument(context);
  const page = await context.newPage();
  context.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/rooms"
    )
      roomAttempts.push(Date.now());
  });
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  return { context, page, errors, consoleErrors };
}
async function startReplay(page: Page, navigate = true) {
  if (navigate) await page.goto("/camera");
  await page.locator("video").evaluate((video) => {
    (video as HTMLVideoElement).loop = true;
  });
  await page.getByLabel("Choose replay video").setInputFiles({
    name: "permitted-bus-still-photo.webm",
    mimeType: "video/webm",
    buffer: replay,
  });
  try {
    await expect(page.getByTestId("analyzed-frame")).toBeVisible({
      timeout: 20_000,
    });
  } catch (error) {
    const state = await page.locator("video").evaluate((element) => {
      const video = element as HTMLVideoElement;
      return {
        time: video.currentTime,
        duration: video.duration,
        readyState: video.readyState,
        paused: video.paused,
        ended: video.ended,
        width: video.videoWidth,
        height: video.videoHeight,
        loop: video.loop,
        quality: video.getVideoPlaybackQuality().totalVideoFrames,
      };
    });
    throw new Error(
      `${String(error)}; replay diagnostics: ${JSON.stringify(state)}`,
    );
  }
  await expect(page.getByTestId("analyzed-frame")).toHaveAttribute(
    "aria-label",
    /[1-9]\d* observed objects/,
  );
  await expect(page.locator(".stage-label")).toHaveText("REPLAY");
}
async function connect(page: Page, code: string) {
  await page.goto("/viewer");
  await page.getByLabel("Camera code").fill(code);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Disconnect and clear" }),
  ).toBeVisible();
}
async function boundedPrivacy(page: Page) {
  const trace = await page.evaluate(() => window.__roadlensTest);
  expect(trace.writes).toEqual([]);
  expect(await page.context().cookies()).toEqual([]);
  expect(
    await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      caches: await caches.keys(),
      databases: await indexedDB.databases(),
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
    })),
  ).toEqual({
    local: 0,
    session: 0,
    caches: [],
    databases: [],
    registrations: 0,
  });
  return trace;
}
async function downloadText(download: Download) {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
async function exportReports(page: Page) {
  const event = page.waitForEvent("download", { timeout: 15_000 });
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  return JSON.parse(await downloadText(await event)) as {
    reports: import("../../shared/src/schemas").Report[];
  };
}
async function reserveRoomWindow(required: number) {
  roomAttempts = roomAttempts.filter((time) => Date.now() - time < 60_500);
  const mustExpire = roomAttempts.length + required - 3;
  if (mustExpire <= 0) return;
  const remaining = Math.max(
    0,
    roomAttempts[mustExpire - 1] + 60_500 - Date.now(),
  );
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ ignoreHTTPSErrors: localTlsAllowed() });
  await page.goto(base);
  // A real, permitted photograph encoded as a still-photo replay fixture. This is not motion/field accuracy evidence.
  const bytes = await page.evaluate(async () => {
    const image = await createImageBitmap(
      await (await fetch("/demo/bus.png")).blob(),
    );
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = Math.round((640 * image.height) / image.width);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(15);
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
      videoBitsPerSecond: 2_000_000,
    });
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start();
    const timer = setInterval(() => {
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    }, 60);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    recorder.stop();
    await stopped;
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    image.close();
    return Array.from(
      new Uint8Array(
        await new Blob(chunks, { type: "video/webm" }).arrayBuffer(),
      ),
    );
  });
  replay = Buffer.from(bytes);
  expect(replay.byteLength).toBeGreaterThan(10_000);
  const cameraPixels = await page.evaluate(async () => {
    const image = await createImageBitmap(
      await (await fetch("/demo/bus.png")).blob(),
    );
    const canvas = document.createElement("canvas");
    const width = 480,
      height = 640;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0, width, height);
    image.close();
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const size = width * height;
    const yuv = new Uint8Array(size * 1.5);
    const clamp = (value: number) =>
      Math.min(255, Math.max(0, Math.round(value)));
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        yuv[y * width + x] = clamp(
          16 + 0.257 * rgba[p] + 0.504 * rgba[p + 1] + 0.098 * rgba[p + 2],
        );
      }
    for (let y = 0; y < height; y += 2)
      for (let x = 0; x < width; x += 2) {
        let r = 0,
          g = 0,
          b = 0;
        for (const offset of [0, 1, width, width + 1]) {
          const p = (y * width + x + offset) * 4;
          r += rgba[p] / 4;
          g += rgba[p + 1] / 4;
          b += rgba[p + 2] / 4;
        }
        const at = (y / 2) * (width / 2) + x / 2;
        yuv[size + at] = clamp(128 - 0.148 * r - 0.291 * g + 0.439 * b);
        yuv[size * 1.25 + at] = clamp(128 + 0.439 * r - 0.368 * g - 0.071 * b);
      }
    return Array.from(yuv);
  });
  fakeCameraImage = Buffer.concat([
    Buffer.from("YUV4MPEG2 W480 H640 F5:1 Ip A1:1 C420jpeg\nFRAME\n"),
    Buffer.from(cameraPixels),
  ]);
  await page.close();
});

test("@cloud B12-B25/B40-B43 privacy: actual model, three contexts, exact frame, report/review, snapshot and cleanup", async ({
  browser,
}, testInfo) => {
  const camera = await pageFor(browser);
  const viewer = await pageFor(browser);
  const late = await pageFor(browser, { width: 390, height: 844 });
  const viewerRequests: string[] = [];
  viewer.context.on("request", (request) => viewerRequests.push(request.url()));
  late.context.on("request", (request) => viewerRequests.push(request.url()));
  const received = new Map<
    string,
    { header: Extract<PacketHeader, { type: "analysis.frame" }>; jpeg: Buffer }
  >();
  viewer.page.on("websocket", (socket) =>
    socket.on("framereceived", (event) => {
      if (typeof event.payload === "string") return;
      const packet = decodePacket(event.payload);
      if (packet.header.type === "analysis.frame")
        received.set(packet.header.frameId, {
          header: packet.header,
          jpeg: Buffer.from(packet.jpeg),
        });
    }),
  );
  try {
    await startReplay(camera.page);
    await camera.page
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await camera.page.getByLabel("Retain exact event images in memory").check();
    await camera.page.getByRole("button", { name: "Close drawer" }).click();
    await camera.page
      .getByRole("button", { name: "Share camera", exact: true })
      .click();
    const code = await camera.page.getByTestId("pairing-code").innerText();
    await connect(viewer.page, code);
    await expect(viewer.page.getByTestId("analyzed-frame")).toBeVisible({
      timeout: 45_000,
    });
    const frameId = await viewer.page
      .getByTestId("analyzed-frame")
      .getAttribute("data-frame-id");
    const packet = received.get(frameId!);
    expect(packet).toBeTruthy();
    expect(packet!.header.result.sourceMode).toBe("replay_video");
    expect(packet!.header.result.executionProvider).toBe("wasm");
    expect(
      packet!.header.result.tracks.some(
        (track) => track.className === "bus" && track.observed,
      ),
    ).toBe(true);
    expect(
      packet!.header.result.tracks.every((track) => track.speedMps === null),
    ).toBe(true);
    const drawing = await viewer.page.evaluate(
      (id) =>
        window.__roadlensTest.drawings
          .slice()
          .reverse()
          .find((value) => value.frameId === id),
      frameId,
    );
    expect(drawing).toBeTruthy();
    const expectedPixels = await viewer.page.evaluate(async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels: number[] = [];
      for (const [x, y] of [
        [0.1, 0.1],
        [0.4, 0.3],
        [0.5, 0.5],
        [0.7, 0.7],
        [0.9, 0.9],
      ])
        pixels.push(
          ...ctx.getImageData(
            Math.floor(x * canvas.width),
            Math.floor(y * canvas.height),
            1,
            1,
          ).data,
        );
      return pixels;
    }, Array.from(packet!.jpeg));
    expect(drawing!.pixels).toEqual(expectedPixels);
    expect(drawing!.width).toBe(packet!.header.imageWidth);
    expect(drawing!.height).toBe(packet!.header.imageHeight);
    const observed = packet!.header.result.tracks.filter(
      (track) => track.observed,
    );
    expect(drawing!.boxes).toHaveLength(observed.length);
    for (let index = 0; index < observed.length; index++) {
      const [x1, y1, x2, y2] = observed[index].bbox;
      const expected = [
        x1 * drawing!.width,
        y1 * drawing!.height,
        (x2 - x1) * drawing!.width,
        (y2 - y1) * drawing!.height,
      ];
      drawing!.boxes[index].forEach((value, axis) =>
        expect(value).toBeCloseTo(expected[axis], 5),
      );
    }
    await camera.page
      .getByRole("button", { name: "Save observation", exact: true })
      .click();
    await expect(viewer.page.locator(".report-row")).toHaveCount(1);
    await viewer.page.locator(".report-row").click();
    await expect(
      viewer.page.getByAltText("Exact event frame retained by the camera"),
    ).toBeVisible();
    await viewer.page
      .getByRole("button", { name: "Mark noted", exact: true })
      .click();
    await expect(viewer.page.locator(".report-row .badge")).toHaveText("noted");
    await expect(camera.page.locator(".report-row .badge")).toHaveText("noted");
    await viewer.page.getByRole("button", { name: "Close drawer" }).click();
    const jsonEvent = viewer.page.waitForEvent("download");
    await viewer.page
      .getByRole("button", { name: "JSON", exact: true })
      .click();
    const json = await downloadText(await jsonEvent);
    const exported = JSON.parse(json);
    expect(exported.reports).toHaveLength(1);
    expect(exported.reports[0]).toMatchObject({
      kind: "observation",
      sourceMode: "replay_video",
      speedMps: null,
      review: "noted",
      revision: 1,
    });
    expect(json).not.toMatch(/ownerToken|viewerToken|pairingCode/);
    const csvEvent = viewer.page.waitForEvent("download");
    await viewer.page.getByRole("button", { name: "CSV", exact: true }).click();
    const csv = await downloadText(await csvEvent);
    expect(csv).toContain("reportId,kind,sourceMode");
    expect(csv).toContain('"replay_video"');
    expect(csv).not.toMatch(/ownerToken|viewerToken|pairingCode/);
    await connect(late.page, code);
    await expect(late.page.locator(".report-row")).toHaveCount(1);
    await expect(late.page.locator(".report-row .badge")).toHaveText("noted");
    await expect(late.page.getByTestId("analyzed-frame")).toBeVisible();
    for (const width of [360, 390, 430]) {
      await late.page.setViewportSize({ width, height: 844 });
      await expect(late.page.locator("body")).toHaveJSProperty(
        "scrollWidth",
        width,
      );
    }
    await late.page.setViewportSize({ width: 390, height: 844 });
    const receiverMetrics = await viewer.page
      .locator(".metrics > div")
      .allTextContents();
    await viewer.page.screenshot({
      path: testInfo.outputPath("desktop-viewer.png"),
      fullPage: true,
    });
    await late.page.screenshot({
      path: testInfo.outputPath("mobile-viewer-390.png"),
      fullPage: true,
    });
    await camera.page
      .locator("video")
      .evaluate((video) => (video as HTMLVideoElement).pause());
    await expect(viewer.page.locator(".page-heading .badge")).toContainText(
      "Source unavailable",
      { timeout: 12_000 },
    );
    await expect(viewer.page.getByTestId("analyzed-frame")).toHaveCount(0);
    await expect(camera.page.getByTestId("analyzed-frame")).toHaveCount(0);
    await viewer.page.locator(".report-row").click();
    await expect(
      viewer.page.getByRole("button", { name: "Mark noted" }),
    ).toBeDisabled();
    await viewer.page.getByRole("button", { name: "Close drawer" }).click();
    await camera.page
      .locator("video")
      .evaluate((video) => (video as HTMLVideoElement).play());
    await expect(viewer.page.locator(".page-heading .badge")).toContainText(
      "Live sampled view",
    );
    await camera.page
      .getByRole("button", { name: "Pause camera", exact: true })
      .click();
    await expect(viewer.page.getByTestId("analyzed-frame")).toHaveCount(0);
    await expect(viewer.page.locator(".report-row")).toHaveCount(1);
    await camera.page
      .getByRole("button", { name: "Resume camera", exact: true })
      .click();
    await expect(viewer.page.getByTestId("analyzed-frame")).toBeVisible({
      timeout: 30_000,
    });
    await expect(camera.page.locator(".report-row")).toHaveCount(1);
    await camera.page
      .getByRole("button", { name: "End session", exact: true })
      .click();
    await camera.page
      .getByRole("button", { name: "End and clear session", exact: true })
      .click();
    await expect(camera.page.locator(".report-row")).toHaveCount(0);
    await expect(viewer.page.locator(".report-row")).toHaveCount(0);
    await expect(late.page.locator(".report-row")).toHaveCount(0);
    await expect(viewer.page.getByLabel("Camera code")).toBeVisible();
    await expect(camera.page.getByRole("alert")).toHaveCount(0);
    const cameraTrace = await boundedPrivacy(camera.page);
    expect(cameraTrace.workersCreated).toBeGreaterThan(0);
    expect(cameraTrace.workersEnded).toBe(cameraTrace.workersCreated);
    expect(cameraTrace.urls).toBe(0);
    expect(cameraTrace.media).toEqual([]);
    for (const page of [viewer.page, late.page]) {
      const trace = await boundedPrivacy(page);
      expect(trace.media).toEqual([]);
      expect(trace.workersCreated).toBe(0);
      expect(trace.urls).toBe(0);
    }
    expect(
      viewerRequests.filter((url) =>
        /\/models\/|\/ort\/|onnxruntime|\/inference\/|\.onnx(?:\?|$)|\.wasm(?:\?|$)/.test(
          url,
        ),
      ),
    ).toEqual([]);
    expect([...camera.errors, ...viewer.errors, ...late.errors]).toEqual([]);
    expect([
      ...camera.consoleErrors,
      ...viewer.consoleErrors,
      ...late.consoleErrors,
    ]).toEqual([]);
    const measurementPath = testInfo.outputPath("browser-measurement.json");
    await writeFile(
      measurementPath,
      JSON.stringify(
        {
          testedAt: new Date().toISOString(),
          environment: process.env.ROADLENS_BASE_URL
            ? "external endpoint"
            : "local development servers",
          source:
            "Permitted still-photo looping Replay fixture; no field-speed claim",
          provider: packet!.header.result.executionProvider,
          profile: packet!.header.result.detectorProfile,
          firstSampleInferenceMs: packet!.header.result.inferenceMs,
          firstSampleAnalysisHz: packet!.header.result.analysisHz,
          firstSampleJpegBytes: packet!.jpeg.length,
          observedObjects: observed.length,
          relayedSamples: received.size,
          receiverMetrics,
          viewerWidths: [1440, 390],
        },
        null,
        2,
      ) + "\n",
    );
    await testInfo.attach("real-browser-measurement", {
      contentType: "application/json",
      path: measurementPath,
    });
  } finally {
    await camera.context.close();
    await viewer.context.close();
    await late.context.close();
  }
});

test("B41/B43 privacy: wrong code, camera rejection and responsive entry stay explicit", async ({
  browser,
}, testInfo) => {
  const instance = await pageFor(browser, { width: 390, height: 844 });
  try {
    await instance.page.goto("/");
    await expect(
      instance.page.getByRole("link", { name: /Start camera/ }),
    ).toBeVisible();
    for (const width of [360, 390, 430]) {
      await instance.page.setViewportSize({ width, height: 844 });
      await expect(instance.page.locator("body")).toHaveJSProperty(
        "scrollWidth",
        width,
      );
    }
    await instance.page.setViewportSize({ width: 390, height: 844 });
    await instance.page.screenshot({
      path: testInfo.outputPath("mobile-entry-390.png"),
      fullPage: true,
    });
    await instance.page.goto("/viewer");
    await instance.page.getByLabel("Camera code").fill("0000-0000");
    await instance.page
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await expect(instance.page.getByRole("alert")).toContainText(
      "Code unavailable",
    );
    await instance.page.goto("/camera");
    await instance.page
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await expect(instance.page.getByRole("alert")).toBeVisible();
    await expect(instance.page.getByTestId("analyzed-frame")).toHaveCount(0);
    const trace = await boundedPrivacy(instance.page);
    expect(trace.media).toEqual([
      {
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      },
    ]);
    expect(trace.workersCreated).toBe(0);
    expect(instance.errors).toEqual([]);
    await instance.page.screenshot({
      path: testInfo.outputPath("camera-unavailable-390.png"),
      fullPage: true,
    });
  } finally {
    await instance.context.close();
  }
});

test("Release privacy: source-only reconnect replaces full snapshots, stop sharing retains local reports, re-pair and End reset settings", async ({
  browser,
}) => {
  await reserveRoomWindow(2);
  const camera = await pageFor(browser);
  const viewer = await pageFor(browser);
  let viewerSockets = 0;
  let phase = "start real replay and pair";
  let blockSource = false;
  await camera.context.routeWebSocket(
    (url) => url.pathname === "/ws",
    (socket) => {
      if (blockSource) socket.close();
      else socket.connectToServer(); // Unmodified real relay traffic; the fault only rejects reconnect attempts.
    },
  );
  viewer.page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname === "/ws") viewerSockets++;
  });
  try {
    await startReplay(camera.page);
    await camera.page
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await camera.page.getByLabel("Road label").fill("Controlled test road");
    await camera.page
      .getByLabel("Speed limit (mph)", { exact: true })
      .fill("37");
    await camera.page
      .getByLabel("Candidate margin (mph)", { exact: true })
      .fill("3");
    await camera.page
      .getByRole("button", { name: "Apply policy", exact: true })
      .click();
    await camera.page
      .getByRole("button", { name: "Save observation", exact: true })
      .click();
    await camera.page
      .getByRole("button", { name: "Save observation", exact: true })
      .click();
    await camera.page
      .getByRole("button", { name: "Share camera", exact: true })
      .click();
    const firstCode = await camera.page.getByTestId("pairing-code").innerText();
    await connect(viewer.page, firstCode);
    await expect(viewer.page.locator(".report-row")).toHaveCount(2);
    const before = (await exportReports(viewer.page)).reports;
    const evictedId = before[0].reportId;
    const retainedId = before[1].reportId;

    // Fault only the source's genuine network connection. Existing viewer sockets stay online.
    phase = "disconnect source socket";
    blockSource = true;
    await camera.page.evaluate(() =>
      window.__roadlensSockets
        .filter((socket) => new URL(socket.url).pathname === "/ws")
        .forEach((socket) => socket.close()),
    );
    await expect(viewer.page.locator(".page-heading .badge")).toContainText(
      "Source offline",
    );
    phase = "review camera-local report during outage";
    await camera.page.locator(".report-row").first().click();
    phase = "save199 camera-local real observations";
    await camera.page
      .getByRole("button", { name: "Mark noted", exact: true })
      .click();
    await camera.page.getByRole("button", { name: "Close drawer" }).click();
    // These are actual button handlers saving the real completed frame, not fabricated report payloads.
    await camera.page
      .getByRole("button", { name: "Save observation", exact: true })
      .evaluate((button) => {
        for (let index = 0; index < 199; index++)
          (button as HTMLButtonElement).click();
      });
    await expect(camera.page.locator(".report-row")).toHaveCount(200);
    phase = "export authoritative offline reports";
    const authoritative = (await exportReports(camera.page)).reports;
    expect(authoritative.some((report) => report.reportId === evictedId)).toBe(
      false,
    );
    expect(
      authoritative.find((report) => report.reportId === retainedId),
    ).toMatchObject({ review: "noted", revision: 1 });
    expect(
      authoritative.every(
        (report) =>
          report.sourceMode === "replay_video" && report.speedMps === null,
      ),
    ).toBe(true);
    phase = "restore source connection and compare complete snapshot";
    blockSource = false;
    await expect(camera.page.getByTestId("connection-state")).toHaveText(
      "Connected",
      { timeout: 15_000 },
    );
    await expect(viewer.page.locator(".report-row")).toHaveCount(200, {
      timeout: 15_000,
    });
    await expect
      .poll(async () => (await exportReports(viewer.page)).reports)
      .toEqual(authoritative);
    expect(viewerSockets).toBe(1);

    phase = "stop sharing and retain local state";
    await camera.page
      .getByRole("button", { name: "Stop sharing", exact: true })
      .click();
    await expect(camera.page.getByTestId("pairing-code")).toHaveCount(0);
    await expect(viewer.page.locator(".report-row")).toHaveCount(0);
    await expect(viewer.page.getByTestId("analyzed-frame")).toHaveCount(0);
    await expect(camera.page.locator(".report-row")).toHaveCount(200);
    await expect(camera.page.getByTestId("analyzed-frame")).toBeVisible();
    expect((await exportReports(camera.page)).reports).toEqual(authoritative);
    await camera.page
      .getByRole("button", { name: "Share camera", exact: true })
      .click();
    const nextCode = await camera.page.getByTestId("pairing-code").innerText();
    expect(nextCode).not.toBe(firstCode);
    await connect(viewer.page, nextCode);
    await expect(viewer.page.locator(".report-row")).toHaveCount(200, {
      timeout: 15_000,
    });
    expect((await exportReports(viewer.page)).reports).toEqual(authoritative);
    await camera.page
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await camera.page.getByLabel("Retain exact event images in memory").check();
    await camera.page.getByRole("button", { name: "Close drawer" }).click();
    await camera.page
      .getByRole("button", { name: "End session", exact: true })
      .click();
    await camera.page
      .getByRole("button", { name: "End and clear session", exact: true })
      .click();
    await expect(camera.page.locator(".report-row")).toHaveCount(0);
    await expect(viewer.page.locator(".report-row")).toHaveCount(0);
    await camera.page
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await expect(
      camera.page.getByLabel("Retain exact event images in memory"),
    ).not.toBeChecked();
    await expect(camera.page.getByLabel("Road label")).toHaveValue("");
    await expect(
      camera.page.getByLabel("Speed limit (mph)", { exact: true }),
    ).toHaveValue("");
    await expect(
      camera.page.getByLabel("Candidate margin (mph)", { exact: true }),
    ).toHaveValue("0");
    await camera.page.getByRole("button", { name: "Close drawer" }).click();
    await expect
      .poll(() => camera.page.evaluate(() => window.__roadlensTest.urls))
      .toBe(0);
    const trace = await boundedPrivacy(camera.page);
    expect(trace.workersEnded).toBe(trace.workersCreated);
    expect(trace.urls).toBe(0);
    expect((await boundedPrivacy(viewer.page)).workersCreated).toBe(0);
    expect([...camera.errors, ...viewer.errors]).toEqual([]);
  } catch (error) {
    throw new Error(`Release phase: ${phase}; ${String(error)}`, {
      cause: error,
    });
  } finally {
    blockSource = false;
    await Promise.allSettled([camera.context.close(), viewer.context.close()]);
  }
});

test("@frontend privacy: real local replay inference, observation and explicit downloads; frontend-only sharing state", async ({
  browser,
}) => {
  const camera = await pageFor(browser);
  const viewer = await pageFor(browser);
  const requests: string[] = [];
  camera.context.on("request", (request) => requests.push(request.url()));
  viewer.context.on("request", (request) => requests.push(request.url()));
  try {
    await startReplay(camera.page);
    await camera.page
      .getByRole("button", { name: "Save observation", exact: true })
      .click();
    const exported = await exportReports(camera.page);
    expect(exported.reports).toHaveLength(1);
    expect(exported.reports[0]).toMatchObject({
      kind: "observation",
      sourceMode: "replay_video",
      speedMps: null,
      evidenceState: "none",
    });
    expect(exported.reports[0].modelSha256).toMatch(/^[a-f0-9]{64}$/);
    const csvEvent = camera.page.waitForEvent("download");
    await camera.page.getByRole("button", { name: "CSV", exact: true }).click();
    expect(await downloadText(await csvEvent)).toContain('"replay_video"');
    expect(exported.reports[0].detectorProfile).toBe("416");
    await camera.page
      .getByRole("button", { name: "Pause camera", exact: true })
      .click();
    await camera.page
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await camera.page.getByLabel("Detector profile").selectOption("320");
    await camera.page
      .getByRole("button", { name: "Close drawer", exact: true })
      .click();
    await camera.page
      .getByRole("button", { name: "Resume camera", exact: true })
      .click();
    await expect(camera.page.getByTestId("analyzed-frame")).toBeVisible();
    await camera.page
      .getByRole("button", { name: "Save observation", exact: true })
      .click();
    const smaller = await exportReports(camera.page);
    expect(smaller.reports).toHaveLength(2);
    expect(
      smaller.reports.map((report) => report.detectorProfile).sort(),
    ).toEqual(["320", "416"]);
    expect(
      new Set(smaller.reports.map((report) => report.captureEpoch)).size,
    ).toBe(2);
    await viewer.page.goto("/viewer");
    if (process.env.ROADLENS_FRONTEND_ONLY === "true") {
      await expect(
        camera.page.getByRole("button", { name: "Share camera", exact: true }),
      ).toBeDisabled();
      await expect(viewer.page.getByLabel("Camera code")).toBeDisabled();
      await expect(
        viewer.page.getByRole("button", { name: "Connect", exact: true }),
      ).toBeDisabled();
      await expect(viewer.page.getByRole("status")).toContainText(
        "Sharing awaits a hosted relay",
      );
      expect(
        requests.filter((url) => /\/api\/|\/healthz(?:\?|$)/.test(url)),
      ).toEqual([]);
    } else {
      await expect(
        camera.page.getByRole("button", { name: "Share camera", exact: true }),
      ).toBeEnabled();
      await expect(viewer.page.getByLabel("Camera code")).toBeEnabled();
    }
    await camera.page
      .getByRole("button", { name: "End session", exact: true })
      .click();
    await camera.page
      .getByRole("button", { name: "End and clear session", exact: true })
      .click();
    await expect(camera.page.locator(".report-row")).toHaveCount(0);
    await expect
      .poll(() => camera.page.evaluate(() => window.__roadlensTest.urls))
      .toBe(0);
    const trace = await boundedPrivacy(camera.page);
    expect(trace.workersCreated).toBeGreaterThan(0);
    expect(trace.workersEnded).toBe(trace.workersCreated);
    expect(trace.urls).toBe(0);
    const viewerTrace = await boundedPrivacy(viewer.page);
    expect(viewerTrace.workersCreated).toBe(0);
    expect(viewerTrace.media).toEqual([]);
    expect([
      ...camera.errors,
      ...viewer.errors,
      ...camera.consoleErrors,
      ...viewer.consoleErrors,
    ]).toEqual([]);
  } finally {
    await camera.context.close();
    await viewer.context.close();
  }
});

test("B42/B43 privacy: pagehide/BFCache clears real local observations and resources", async ({
  browser,
}) => {
  const instance = await pageFor(browser);
  try {
    await startReplay(instance.page);
    await instance.page
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await instance.page
      .getByLabel("Retain exact event images in memory")
      .check();
    await instance.page
      .getByLabel("Road label")
      .fill("Temporary BFCache policy");
    await instance.page
      .getByLabel("Speed limit (mph)", { exact: true })
      .fill("25");
    await instance.page
      .getByLabel("Candidate margin (mph)", { exact: true })
      .fill("2");
    await instance.page
      .getByRole("button", { name: "Apply policy", exact: true })
      .click();
    await instance.page
      .getByRole("button", { name: "Save observation", exact: true })
      .click();
    await expect(instance.page.locator(".report-row")).toHaveCount(1);
    await instance.page.evaluate(() => {
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      );
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
    });
    await expect(instance.page.locator(".report-row")).toHaveCount(0);
    await expect(instance.page.getByTestId("analyzed-frame")).toHaveCount(0);
    const trace = await boundedPrivacy(instance.page);
    expect(trace.urls).toBe(0);
    expect(trace.workersEnded).toBe(trace.workersCreated);
    await instance.page
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await expect(
      instance.page.getByLabel("Retain exact event images in memory"),
    ).not.toBeChecked();
    await expect(instance.page.getByLabel("Road label")).toHaveValue("");
    await expect(
      instance.page.getByLabel("Speed limit (mph)", { exact: true }),
    ).toHaveValue("");
    await expect(
      instance.page.getByLabel("Candidate margin (mph)", { exact: true }),
    ).toHaveValue("0");
    await instance.page.reload();
    await expect(instance.page.locator(".report-row")).toHaveCount(0);
    expect(instance.errors).toEqual([]);
  } finally {
    await instance.context.close();
  }
});

test("Release privacy: synthetic delivery delay on real worker results triggers actual416-to320 model adaptation", async ({
  browser,
}) => {
  const instance = await pageFor(browser);
  const models: string[] = [];
  instance.context.on("request", (request) => {
    if (/\.onnx(?:\?|$)/.test(request.url())) models.push(request.url());
  });
  await instance.context.addInitScript(() => {
    const NativeWorker = window.Worker;
    let prototype = NativeWorker.prototype;
    let descriptor: PropertyDescriptor | undefined;
    while (prototype && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, "onmessage");
      prototype = Object.getPrototypeOf(prototype);
    }
    if (!descriptor?.set)
      throw new Error("Native worker message setter unavailable");
    const setMessage = descriptor.set;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        let listener: ((event: MessageEvent) => void) | null = null;
        Object.defineProperty(this, "onmessage", {
          configurable: true,
          get: () => listener,
          set: (next: ((event: MessageEvent) => void) | null) => {
            listener = next;
            setMessage.call(
              this,
              next
                ? (event: MessageEvent) => {
                    // Only delay delivery. The actual worker, graph and detection payload remain unchanged.
                    if (event.data?.type === "result")
                      setTimeout(() => next.call(this, event), 350);
                    else next.call(this, event);
                  }
                : null,
            );
          },
        });
      }
    };
  });
  try {
    await startReplay(instance.page);
    const firstId = await instance.page
      .getByTestId("analyzed-frame")
      .getAttribute("data-frame-id");
    await expect(instance.page.getByRole("status")).toContainText("320", {
      timeout: 20_000,
    });
    await expect(instance.page.getByTestId("analyzed-frame")).toBeVisible();
    await expect(
      instance.page.getByTestId("analyzed-frame"),
    ).not.toHaveAttribute("data-frame-id", firstId!);
    await instance.page
      .getByRole("button", { name: "Save observation", exact: true })
      .click();
    const reports = (await exportReports(instance.page)).reports;
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      detectorProfile: "320",
      sourceMode: "replay_video",
      speedMps: null,
    });
    expect(models.some((url) => url.includes("yolo26n-416.onnx"))).toBe(true);
    expect(models.some((url) => url.includes("yolo26n-320.onnx"))).toBe(true);
    await instance.page
      .getByRole("button", { name: "End session", exact: true })
      .click();
    await instance.page
      .getByRole("button", { name: "End and clear session", exact: true })
      .click();
    await expect
      .poll(() => instance.page.evaluate(() => window.__roadlensTest.urls))
      .toBe(0);
    const trace = await boundedPrivacy(instance.page);
    expect(trace.workersEnded).toBe(trace.workersCreated);
    expect(trace.media).toEqual([]);
    expect([...instance.errors, ...instance.consoleErrors]).toEqual([]);
  } finally {
    await instance.context.close();
  }
});

test("B41 privacy: failed actual model download shows error and releases its worker", async ({
  browser,
}) => {
  const instance = await pageFor(browser);
  try {
    await instance.context.route("**/models/yolo26n-416.onnx", (route) =>
      route.abort("failed"),
    );
    await instance.page.goto("/camera");
    await instance.page.locator("video").evaluate((video) => {
      (video as HTMLVideoElement).loop = true;
    });
    await instance.page.getByLabel("Choose replay video").setInputFiles({
      name: "permitted-bus-still-photo.webm",
      mimeType: "video/webm",
      buffer: replay,
    });
    await expect(instance.page.getByRole("alert")).toBeVisible();
    await expect(instance.page.getByTestId("analyzed-frame")).toHaveCount(0);
    const trace = await boundedPrivacy(instance.page);
    expect(trace.workersCreated).toBe(1);
    expect(trace.workersEnded).toBe(1);
    expect(instance.errors).toEqual([]);
  } finally {
    await instance.context.close();
  }
});

test("B42 privacy: delayed real room/join responses cannot resurrect an ended page", async ({
  browser,
}) => {
  // This test creates two rooms. Honor the unchanged production limit of three creations/minute
  // after the complete-flow and re-pair tests; this is a real-time test scheduling gap.
  await reserveRoomWindow(2);
  const owner = await pageFor(browser);
  const viewer = await pageFor(browser);
  try {
    let releaseRoom!: () => void;
    let roomSeen!: () => void;
    const heldRoom = new Promise<void>((resolve) => {
      releaseRoom = resolve;
    });
    const sawRoom = new Promise<void>((resolve) => {
      roomSeen = resolve;
    });
    await owner.context.route("**/api/rooms", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      roomSeen();
      await heldRoom;
      await route.fulfill({ response });
    });
    await owner.page.goto("/camera");
    await owner.page
      .getByRole("button", { name: "Share camera", exact: true })
      .click();
    await sawRoom;
    await owner.page
      .getByRole("button", { name: "End session", exact: true })
      .click();
    await owner.page
      .getByRole("button", { name: "End and clear session", exact: true })
      .click();
    releaseRoom();
    await expect(
      owner.page.getByRole("button", { name: "Share camera", exact: true }),
    ).toBeEnabled();
    await expect(owner.page.getByTestId("pairing-code")).toHaveCount(0);
    await owner.context.unroute("**/api/rooms");
    await owner.page
      .getByRole("button", { name: "Share camera", exact: true })
      .click();
    const code = await owner.page.getByTestId("pairing-code").innerText();
    let releaseJoin!: () => void;
    let joinSeen!: () => void;
    const heldJoin = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
    const sawJoin = new Promise<void>((resolve) => {
      joinSeen = resolve;
    });
    await viewer.context.route("**/api/join", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      joinSeen();
      await heldJoin;
      await route.fulfill({ response });
    });
    await viewer.page.goto("/viewer");
    await viewer.page.getByLabel("Camera code").fill(code);
    await viewer.page
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await sawJoin;
    await viewer.page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      ),
    );
    releaseJoin();
    await expect(
      viewer.page.getByRole("button", { name: "Connect", exact: true }),
    ).toBeEnabled();
    await expect(
      viewer.page.getByRole("button", { name: "Disconnect and clear" }),
    ).toHaveCount(0);
    await expect(viewer.page.locator(".report-row")).toHaveCount(0);
    await owner.page
      .getByRole("button", { name: "Stop sharing", exact: true })
      .click();
    await expect(owner.page.getByTestId("pairing-code")).toHaveCount(0);
    await boundedPrivacy(owner.page);
    await boundedPrivacy(viewer.page);
    expect([...owner.errors, ...viewer.errors]).toEqual([]);
  } finally {
    await owner.context.close();
    await viewer.context.close();
  }
});

test("B12/B42 privacy: replay switches to explicit Chromium fake camera with real getUserMedia/model and stops tracks", async ({}, testInfo) => {
  const path = testInfo.outputPath("permitted-still-photo-fake-camera.y4m");
  await writeFile(path, fakeCameraImage);
  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${path}`,
    ],
  });
  const context = await browser.newContext({
    baseURL: base,
    permissions: ["camera"],
    ignoreHTTPSErrors: localTlsAllowed(),
  });
  await instrument(context);
  const page = await context.newPage();
  try {
    await startReplay(page);
    const replayFrameId = await page
      .getByTestId("analyzed-frame")
      .getAttribute("data-frame-id");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Use device camera", exact: true })
      .click();
    try {
      await expect(page.getByTestId("analyzed-frame")).toBeVisible({
        timeout: 10_000,
      });
    } catch (error) {
      const diagnostic = await page.evaluate(async () => {
        let direct: unknown;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
          direct = stream.getVideoTracks().map((track) => ({
            state: track.readyState,
            settings: track.getSettings(),
          }));
          stream.getTracks().forEach((track) => track.stop());
        } catch (e) {
          direct = { name: (e as Error).name, message: (e as Error).message };
        }
        return {
          trace: window.__roadlensTest,
          direct,
          devices: (await navigator.mediaDevices.enumerateDevices()).map(
            (device) => device.kind,
          ),
        };
      });
      throw new Error(
        `${String(error)}; fake-camera diagnostic: ${JSON.stringify(diagnostic)}`,
      );
    }
    await expect(page.getByTestId("analyzed-frame")).toHaveAttribute(
      "aria-label",
      /[1-9]\d* observed objects/,
    );
    await expect(page.locator(".stage-label")).toHaveText("ANALYZED VIEW");
    await expect(page.getByTestId("analyzed-frame")).not.toHaveAttribute(
      "data-frame-id",
      replayFrameId!,
    );
    expect(
      await page
        .locator("video")
        .evaluate(
          (element) =>
            (element as HTMLVideoElement).srcObject instanceof MediaStream,
        ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Pause camera", exact: true })
      .click();
    await expect(page.getByTestId("analyzed-frame")).toHaveCount(0);
    expect(
      await page
        .locator("video")
        .evaluate((element) => (element as HTMLVideoElement).srcObject),
    ).toBeNull();
    const trace = await boundedPrivacy(page);
    expect(trace.media).toHaveLength(1);
    expect(trace.media[0].audio).toBe(false);
    expect(trace.tracksStopped).toBeGreaterThanOrEqual(1);
    expect(trace.workersCreated).toBeGreaterThan(0);
    expect(trace.workersEnded).toBe(trace.workersCreated);
  } finally {
    await context.close();
    await browser.close();
  }
});
