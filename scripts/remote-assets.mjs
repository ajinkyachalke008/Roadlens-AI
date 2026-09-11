import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function publicOrigin(value) {
  if (!value)
    throw new Error("Set ROADLENS_BASE_URL to the actual public HTTPS origin");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Expected a public HTTPS origin without credentials or path",
    );
  return url.origin;
}
export async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${new URL(url).pathname}`);
  return response;
}
export async function verifyRemoteAssets(web) {
  await get(new URL("/", web));
  for (const side of [416, 320]) {
    const expected = JSON.parse(
      await readFile(
        new URL(
          `../frontend/public/models/yolo26n-${side}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const remote = await (
      await get(new URL(`/models/yolo26n-${side}.json`, web))
    ).json();
    if (JSON.stringify(remote) !== JSON.stringify(expected))
      throw new Error("Deployed model manifest differs from checked release");
    await artifact(
      web,
      `/models/${expected.file}`,
      expected,
      "application/octet-stream",
    );
  }
  const expected = JSON.parse(
    await readFile(
      new URL("../frontend/public/ort/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const remote = await (await get(new URL("/ort/manifest.json", web))).json();
  if (JSON.stringify(remote) !== JSON.stringify(expected))
    throw new Error("Deployed runtime manifest differs from checked release");
  for (const file of expected.files)
    await artifact(
      web,
      `/ort/${file.name}`,
      file,
      file.name.endsWith(".wasm") ? "application/wasm" : "javascript",
    );
  for (const path of ["/models/not-present.onnx", "/ort/not-present.wasm"]) {
    if (
      (await fetch(new URL(path, web), { signal: AbortSignal.timeout(20_000) }))
        .status !== 404
    )
      throw new Error("Missing asset must return 404");
  }
}
async function artifact(web, path, expected, mime) {
  const response = await get(new URL(path, web));
  if (!response.headers.get("content-type")?.includes(mime))
    throw new Error(`Incorrect MIME: ${path}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length !== expected.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  )
    throw new Error(`Release asset bytes/hash mismatch: ${path}`);
}
