import { spawn } from "node:child_process";
import { publicOrigin, get, verifyRemoteAssets } from "./remote-assets.mjs";
const web = publicOrigin(process.env.ROADLENS_BASE_URL);
const relay = publicOrigin(process.env.ROADLENS_RELAY_URL ?? web);
const health = await (await get(new URL("/healthz", relay))).json();
if (health.v !== 2 || !health.healthy)
  throw new Error("Relay health contract mismatch");
await verifyRemoteAssets(web);
const missing = await fetch(new URL("/api/not-present", relay), {
  headers: { Origin: web },
  signal: AbortSignal.timeout(20_000),
});
if (missing.status !== 404)
  throw new Error("Missing API route must return 404");
console.log(
  "Cloud HTTPS health, checked-release model/runtime MIME+hashes and missing assets passed. Running real paired browser flow.",
);
const child = spawn(
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
    stdio: "inherit",
    env: { ...process.env, ROADLENS_BASE_URL: web, ROADLENS_RELAY_URL: relay },
    windowsHide: true,
  },
);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
process.exitCode = code ?? 1;
