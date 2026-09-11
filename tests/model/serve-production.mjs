import { build, preview } from "vite";
import { fileURLToPath } from "node:url";
const configFile = fileURLToPath(
  new URL("../../frontend/vite.config.ts", import.meta.url),
);
const outDir = fileURLToPath(new URL("./dist/", import.meta.url));
await build({ configFile, build: { outDir, emptyOutDir: true } });
await preview({
  configFile,
  build: { outDir },
  preview: { host: "127.0.0.1", port: 5176, strictPort: true },
});
