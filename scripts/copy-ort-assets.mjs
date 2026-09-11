import { readFile, mkdir, copyFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
const runtime = new URL("node_modules/onnxruntime-web/", root);
const destination = new URL("frontend/public/ort/", root);
await mkdir(destination, { recursive: true });
const { version } = JSON.parse(
  await readFile(new URL("package.json", runtime), "utf8"),
);
const files = [];
for (const name of [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
]) {
  const source = new URL(`dist/${name}`, runtime),
    bytes = await readFile(source);
  await copyFile(source, new URL(name, destination));
  files.push({
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
// The npm tarball omits LICENSE. The checked-in notice is from the matching upstream release.
await readFile(new URL("ORT-LICENSE.txt", destination), "utf8");
await writeFile(
  new URL("manifest.json", destination),
  JSON.stringify(
    { version, executionProvider: "wasm", numThreads: 1, files },
    null,
    2,
  ) + "\n",
);
console.log(
  `Copied ONNX Runtime Web ${version} WASM assets (${files.reduce((n, f) => n + f.bytes, 0)} bytes).`,
);
