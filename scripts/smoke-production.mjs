import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

// Exercise the actual compiled, single-process deployment locally. This is not cloud evidence.
const origin = "http://127.0.0.1:10002";
const server = spawn(process.execPath, ["dist/backend/src/main.js"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: "10002",
    SERVE_WEB: "true",
    ALLOWED_ORIGINS: origin,
  },
  stdio: "ignore",
  windowsHide: true,
});
try {
  let healthy = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (server.exitCode !== null)
      throw new Error("Compiled production relay exited before health check");
    try {
      const response = await fetch(`${origin}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      const health = await response.json();
      if (response.ok && health.v === 2 && health.healthy) {
        healthy = true;
        break;
      }
    } catch {
      /* Starting our own process; bounded readiness wait. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!healthy)
    throw new Error("Compiled production relay did not become healthy");
  for (const side of [416, 320]) {
    const manifest = await (
      await fetch(`${origin}/models/yolo26n-${side}.json`)
    ).json();
    const response = await fetch(`${origin}/models/${manifest.file}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      !response.headers
        .get("content-type")
        ?.includes("application/octet-stream") ||
      bytes.length !== manifest.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
    )
      throw new Error("Production model MIME/bytes/hash mismatch");
  }
  for (const path of [
    "/models/not-present.onnx",
    "/ort/not-present.wasm",
    "/not-an-app-route",
  ]) {
    if ((await fetch(`${origin}${path}`)).status !== 404)
      throw new Error("Production missing asset did not return 404");
  }
  const runtime = await (await fetch(`${origin}/ort/manifest.json`)).json();
  for (const file of runtime.files) {
    const response = await fetch(`${origin}/ort/${file.name}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      file.name.endsWith(".wasm") &&
      !response.headers.get("content-type")?.includes("application/wasm")
    )
      throw new Error("Production WASM MIME mismatch");
    if (
      bytes.length !== file.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      throw new Error("Production runtime bytes/hash mismatch");
  }
  console.log(
    "Local compiled production health, model/runtime integrity and missing-asset checks passed.",
  );
  const test = spawn(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      "playwright.config.ts",
      "--grep",
      "@cloud",
    ],
    {
      env: { ...process.env, ROADLENS_BASE_URL: origin },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const code = await new Promise((resolve, reject) => {
    test.once("error", reject);
    test.once("exit", resolve);
  });
  if (code !== 0)
    throw new Error(`Local production browser flow failed (${code})`);
} finally {
  server.kill();
}
