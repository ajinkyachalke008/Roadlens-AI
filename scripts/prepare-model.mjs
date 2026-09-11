import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.includes("--export")) {
  const python =
    process.env.ROADLENS_PYTHON ||
    `${root}training/${process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"}`;
  if (!existsSync(python))
    throw new Error(
      "Explicit export needs training/.venv with training/requirements.lock.txt; see training/README.md. Packaged models need no Python.",
    );
  const result = spawnSync(python, ["training/export.py"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
} else {
  for (const side of [416, 320]) {
    const folder = new URL("../frontend/public/models/", import.meta.url);
    // Source-controlled manifest is the integrity trust anchor; do not trust a downloaded hash.
    const manifest = JSON.parse(
      await readFile(new URL(`yolo26n-${side}.json`, folder), "utf8"),
    );
    if (
      !/^[-\w]+\.onnx$/.test(manifest.file) ||
      !Number.isInteger(manifest.bytes) ||
      manifest.bytes > 32 * 1024 * 1024 ||
      manifest.bytes < 1000 ||
      !/^[a-f\d]{64}$/.test(manifest.sha256)
    )
      throw new Error("Invalid pinned model manifest");
    const target = new URL(manifest.file, folder);
    if (existsSync(target)) continue;
    if (!process.env.MODEL_ASSET_BASE_URL)
      throw new Error(
        `Missing packaged ${manifest.file}. Include the verified ONNX files in the deployment package, run npm run model:prepare -- --export locally, or set MODEL_ASSET_BASE_URL to your explicitly authorized HTTPS artifact directory. No model-host URL is configured.`,
      );
    const base = new URL(process.env.MODEL_ASSET_BASE_URL);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error(
        "MODEL_ASSET_BASE_URL must be an HTTPS directory without credentials, query, or fragment",
      );
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const response = await fetch(new URL(manifest.file, base), {
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok || !response.body)
      throw new Error(
        `Configured model source did not return ${manifest.file}`,
      );
    const bytes = new Uint8Array(manifest.bytes);
    let count = 0;
    for await (const part of response.body) {
      if (count + part.length > bytes.length)
        throw new Error("Downloaded model exceeds pinned byte size");
      bytes.set(part, count);
      count += part.length;
    }
    if (
      count !== manifest.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
    )
      throw new Error("Downloaded model does not match pinned SHA-256/bytes");
    await mkdir(folder, { recursive: true });
    await writeFile(target, bytes);
  }
}
await import("./copy-ort-assets.mjs");
await import("./verify-model.mjs");
