import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
for (const side of [416, 320]) {
  const manifest = JSON.parse(
    await readFile(
      new URL(`frontend/public/models/yolo26n-${side}.json`, root),
      "utf8",
    ),
  );
  const bytes = await readFile(
    new URL(`frontend/public/models/${manifest.file}`, root),
  );
  if (
    bytes.length !== manifest.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
  )
    throw new Error(`Model ${side} integrity mismatch`);
  if (
    JSON.stringify(manifest.input.shape) !==
      JSON.stringify([1, 3, side, side]) ||
    JSON.stringify(manifest.output.shape) !== "[1,300,6]" ||
    manifest.output.format !== "yolo_e2e_xyxy_score_class"
  )
    throw new Error("Unverified graph semantics");
  console.log(`${manifest.id}: bytes and SHA-256 verified`);
}
const runtime = JSON.parse(
  await readFile(new URL("frontend/public/ort/manifest.json", root), "utf8"),
);
const installed = JSON.parse(
  await readFile(
    new URL("node_modules/onnxruntime-web/package.json", root),
    "utf8",
  ),
);
if (runtime.version !== installed.version)
  throw new Error("ORT asset version mismatch");
for (const f of runtime.files) {
  const bytes = await readFile(new URL(`frontend/public/ort/${f.name}`, root));
  if (
    bytes.length !== f.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== f.sha256
  )
    throw new Error("ORT asset integrity mismatch");
}
console.log(
  `ORT ${runtime.version}: all public runtime assets verified. Browser execution is a separate test.`,
);
