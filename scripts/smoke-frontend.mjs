import { spawn } from "node:child_process";
import { publicOrigin, verifyRemoteAssets } from "./remote-assets.mjs";
const web = publicOrigin(process.env.ROADLENS_BASE_URL);
await verifyRemoteAssets(web);
console.log(
  "Public frontend HTTPS, release model/runtime MIME+hashes and missing assets passed. Testing real browser analysis/local reports; this is not full relay cloud smoke.",
);
const child = spawn(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "playwright.config.ts",
    "--grep",
    "@frontend",
  ],
  {
    env: {
      ...process.env,
      ROADLENS_BASE_URL: web,
      ROADLENS_FRONTEND_ONLY: "true",
    },
    stdio: "inherit",
    windowsHide: true,
  },
);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
process.exitCode = code ?? 1;
