// Measures the real production path: Vercel frontend -> Render relay -> local
// CUDA worker. No latency is injected; this is the actual hosted round trip.
import { chromium } from "@playwright/test";
const base =
  process.env.ROADLENS_BASE_URL?.trim() ||
  "https://roadlens-ai-five.vercel.app";
const seconds = Number(process.argv[2] ?? 30);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (v) => {
  if (!v.length) return null;
  const a = [...v].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const context = await browser.newContext({
  permissions: ["camera"],
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
try {
  await page.goto(base + "/camera", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  const analyzed = page.getByTestId("analyzed-frame");
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const provider = (await analyzed.getAttribute("data-provider")) ?? "";
    if (/cuda|tensorrt/.test(provider)) break;
    await wait(1000);
  }
  const provider = await analyzed.getAttribute("data-provider");
  if (!/cuda|tensorrt/.test(provider ?? ""))
    throw new Error(`GPU provider never engaged (saw ${provider})`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("details.diagnostics > summary").click({ timeout: 3000 }).catch(() => {});
  await wait(5000);
  const samples = [];
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    samples.push(
      await page.evaluate(() => {
        const read = (id) => ({ ...document.querySelector(`[data-testid="${id}"]`)?.dataset });
        return { capture: read("capture-diagnostics"), gpu: read("gpu-diagnostics"), perf: read("performance-summary") };
      }),
    );
    await wait(500);
  }
  const num = (g, k) => samples.map((s) => Number(s[g]?.[k])).filter((v) => Number.isFinite(v) && v > 0);
  const last = samples.at(-1) ?? {};
  console.log(JSON.stringify({
    measuredAt: new Date().toISOString(),
    base,
    samples: samples.length,
    cameraFps: median(num("capture", "sourceHz")),
    analysisFps: median(num("capture", "analysisHz")),
    submittedHz: median(num("gpu", "submittedHz")),
    resultHz: median(num("gpu", "resultHz")),
    rttMs: median(num("gpu", "rttMs")),
    resultAgeMs: median(num("gpu", "resultAgeMs")),
    overlayAgeMs: median(num("perf", "overlayAgeMs")),
    displayHz: median(num("perf", "displayHz")),
    encodeMs: median(num("gpu", "encodeMs")),
    workerTotalMs: median(num("gpu", "workerTotalMs")),
    gpuInferenceMs: median(num("gpu", "gpuInferenceMs")),
    maxInFlight: Number(last.gpu?.maxInFlight ?? last.capture?.maxInFlight ?? 0),
    submitted: Number(last.gpu?.submitted ?? 0),
    completed: Number(last.gpu?.completed ?? 0),
    dropped: Number(last.gpu?.dropped ?? 0),
    superseded: Number(last.capture?.superseded ?? 0),
    stale: Number(last.capture?.stale ?? 0),
    consoleErrors: errors,
  }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
