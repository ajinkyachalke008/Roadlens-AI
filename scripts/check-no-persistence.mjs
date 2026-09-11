import { readFile, readdir } from "node:fs/promises";
const forbidden = [
  /\b(localStorage|sessionStorage|indexedDB|caches)\s*[.\[]/,
  /navigator\s*\.\s*serviceWorker/,
  /\b(document\.cookie|localforage)\b/,
  /\b(supabase|firebase|redis|mongoose|prisma|sqlite|cloudflare)\b/i,
  /console\.(log|debug|info|warn|error)\s*\(/,
];
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
      ),
    )
  ).flat();
}
let count = 0;
for (const root of ["frontend/src", "backend/src", "shared/src"])
  for (const path of await files(root)) {
    if (!/\.[jt]sx?$/.test(path)) continue;
    const source = await readFile(path, "utf8");
    for (const pattern of forbidden)
      if (pattern.test(source))
        throw new Error(
          `Unexpected durable storage, service or logging reference: ${path} (${pattern})`,
        );
    count++;
  }
const manifest = JSON.parse(await readFile("package.json", "utf8"));
for (const name of Object.keys(manifest.dependencies ?? {}))
  if (/supabase|firebase|redis|prisma|sqlite|cloudflare|auth0/.test(name))
    throw new Error("Disallowed runtime dependency");
console.log(
  `Privacy source check passed: ${count} application modules; no durable storage APIs, telemetry/content logging, or prohibited service dependencies. Runtime privacy spies run separately.`,
);
