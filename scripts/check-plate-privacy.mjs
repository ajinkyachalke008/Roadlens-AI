import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

/**
 * Plate-specific privacy and secret scan, run as part of `npm run test:privacy`.
 *
 * The generic persistence check already forbids durable storage and logging
 * across the application. This adds the things that only matter once the project
 * can read a plate: that no plate photograph, plate transcription, dataset
 * credential or environment file can reach a commit, and that the plate modules
 * cannot send anything anywhere except through the GPU transport they belong to.
 *
 * It inspects what Git actually tracks, not the working tree, because that is
 * what a push would publish.
 */
const run = promisify(execFile);
const tracked = async () =>
  (await run("git", ["ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 })).stdout
    .split("\0")
    .filter(Boolean);

/** Datasets and model caches are local artifacts; none of them may be tracked. */
const forbiddenPaths = [
  {
    pattern: /^training\/data\//,
    reason: "dataset images or ground truth under training/data/",
  },
  {
    pattern: /^worker\/models\//,
    reason: "cached model weights under worker/models/",
  },
  {
    pattern: /\.(pt|onnx|engine|weights)$/,
    reason: "model weights",
    allow: /^frontend\/(public|dist)\/models\//,
  },
  {
    pattern: /^\.env/,
    reason: "environment file",
    allow: /\.example$/,
  },
];
/**
 * Application source has no business containing a plate transcription. Tests and
 * documentation deliberately do (a worked consensus example is worth more than a
 * prose description), so only shipped source is scanned.
 */
const plateLiteral = /["'`](?=[A-Z0-9]{6,8}["'`])(?=[A-Z]*[0-9])(?=[0-9]*[A-Z])[A-Z0-9]{6,8}["'`]/;
const secretPatterns = [
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, reason: "AWS access key id" },
  { pattern: /\bghp_[A-Za-z0-9]{36}\b/, reason: "GitHub token" },
  { pattern: /\bhf_[A-Za-z0-9]{34}\b/, reason: "Hugging Face token" },
  { pattern: /\bsk-[A-Za-z0-9]{32,}\b/, reason: "API secret key" },
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    reason: "private key",
  },
  {
    pattern: /\b(?:roboflow|kaggle)[_-]?(?:api[_-]?)?key\s*[:=]\s*["'][^"']+["']/i,
    reason: "dataset credential",
  },
];
/** Nothing in the plate pipeline may reach the network on its own. */
const forbiddenEgress =
  /\b(fetch|XMLHttpRequest|sendBeacon|EventSource|importScripts)\s*\(/;

const failures = [];
const files = await tracked();
for (const path of files) {
  for (const { pattern, reason, allow } of forbiddenPaths)
    if (pattern.test(path) && !(allow && allow.test(path)))
      failures.push(`${path}: ${reason} must never be committed`);
}
const sourceFiles = files.filter(
  (path) =>
    /^(frontend\/src|backend\/src|shared\/src)\//.test(path) &&
    /\.[jt]sx?$/.test(path),
);
for (const path of sourceFiles) {
  const source = await readFile(path, "utf8");
  if (plateLiteral.test(source))
    failures.push(`${path}: application source contains a plate-like literal`);
  if (path.startsWith("frontend/src/plates/") && forbiddenEgress.test(source))
    failures.push(`${path}: plate modules must not perform their own network I/O`);
}
for (const path of files) {
  if (/\.(png|jpe?g|webp|gif|bmp|mp4|mov|avi|onnx|pt|wasm|ico)$/i.test(path))
    continue;
  const source = await readFile(path, "utf8").catch(() => "");
  for (const { pattern, reason } of secretPatterns)
    if (pattern.test(source)) failures.push(`${path}: ${reason}`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  throw new Error(`Plate privacy scan failed with ${failures.length} finding(s)`);
}
console.log(
  `Plate privacy scan passed: ${files.length} tracked files; no plate images, transcriptions in shipped source, dataset credentials, secrets or environment files, and no independent network I/O in the plate modules.`,
);
