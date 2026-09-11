import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

// Local release smoke only: production Vite output, actual compiled relay,
// distinct HTTPS origins and WSS. This does not establish cloud/phone operation.
// The certificate is an ephemeral test asset; no system trust store is changed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checksOnly = process.argv.includes("--checks-only");
if (process.argv.slice(2).some((arg) => arg !== "--checks-only"))
  throw new Error("Usage: node scripts/smoke-split.mjs [--checks-only]");
const abort = new AbortController();
const children = new Set();
const sockets = new Set();
const servers = [];
let temporaryRoot;
let relay;
let frontendApiRequests = 0;
let proxyRequests = 0;
let proxyUpgrades = 0;

function stopChild(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  else child.kill("SIGTERM");
}
function run(
  command,
  args,
  { env = {}, quiet = false, timeout = 180_000 } = {},
) {
  return new Promise((resolveRun, reject) => {
    abort.signal.throwIfAborted();
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: quiet ? ["ignore", "ignore", "pipe"] : "inherit",
      windowsHide: true,
    });
    children.add(child);
    let diagnostics = "";
    if (quiet)
      child.stderr.on("data", (chunk) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-4096);
      });
    let timedOut = false;
    const cancel = () => stopChild(child);
    abort.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild(child);
    }, timeout);
    const done = () => {
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", cancel);
      children.delete(child);
    };
    child.once("error", (error) => {
      done();
      reject(error);
    });
    child.once("close", (code) => {
      done();
      if (abort.signal.aborted) reject(abort.signal.reason);
      else if (timedOut) reject(new Error("Split smoke subprocess timed out"));
      else if (code !== 0)
        reject(
          new Error(
            `Split smoke ${basename(command)} subprocess failed (${code})${diagnostics ? ": " + diagnostics.trim() : ""}`,
          ),
        );
      else resolveRun();
    });
  });
}
function trackSocket(socket) {
  if (sockets.has(socket)) return socket;
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  return socket;
}
async function listen(server) {
  servers.push(server);
  server.on("connection", trackSocket);
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};
function staticHandler(directory) {
  return async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, "https://localhost").pathname,
      );
      if (
        pathname.startsWith("/api/") ||
        pathname === "/ws" ||
        pathname === "/healthz"
      )
        frontendApiRequests++;
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }
      const appRoute = ["/", "/camera", "/viewer"].includes(pathname);
      const filename = resolve(
        directory,
        appRoute ? "index.html" : "." + pathname,
      );
      if (!inside(directory, filename)) {
        response.writeHead(403).end();
        return;
      }
      const canonical = await realpath(filename);
      if (!inside(directory, canonical)) {
        response.writeHead(403).end();
        return;
      }
      const file = await stat(canonical);
      if (!file.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Content-Type":
          mimeTypes[extname(canonical)] ?? "application/octet-stream",
        "Content-Length": file.size,
        "Cache-Control": appRoute ? "no-store" : "public, max-age=60",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else
        createReadStream(canonical)
          .on("error", () => response.destroy())
          .pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    }
  };
}
function secureRequest(
  url,
  certificate,
  { method = "GET", headers = {}, body } = {},
) {
  return new Promise((resolveRequest, reject) => {
    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = https.request(
      url,
      {
        method,
        ca: certificate,
        signal: abort.signal,
        headers: {
          ...headers,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
              }
            : {}),
        },
        timeout: 15_000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          resolveRequest({
            status: response.statusCode,
            headers: response.headers,
            bytes: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once("timeout", () =>
      request.destroy(new Error("HTTPS smoke request timed out")),
    );
    request.once("error", reject);
    request.end(payload);
  });
}
function rejectedUpgrade(url, certificate, origin) {
  return new Promise((resolveUpgrade, reject) => {
    const socket = new WebSocket(url, {
      ca: certificate,
      origin,
      handshakeTimeout: 5000,
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Origin rejection deadline exceeded"));
    }, 6000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error("Disallowed Origin received a WSS upgrade"));
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      socket.terminate();
      if (response.statusCode === 403) resolveUpgrade();
      else
        reject(
          new Error(`Disallowed Origin returned HTTP ${response.statusCode}`),
        );
    });
    socket.on("error", () => {
      /* Rejected upgrades also produce an expected ws error. */
    });
  });
}
function allowedUpgrade(url, certificate, origin) {
  return new Promise((resolveUpgrade, reject) => {
    const socket = new WebSocket(url, {
      ca: certificate,
      origin,
      handshakeTimeout: 5000,
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Allowed Origin WSS probe timed out"));
    }, 6000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("open", () => {
      // This verifies the Origin gate only. The subsequent browser flow proves
      // role-bound hello/pairing; this unbound probe closes without creating a room.
      socket.close();
      socket.once("close", () => {
        clearTimeout(timer);
        resolveUpgrade();
      });
    });
  });
}
async function assertAssets(frontendOrigin, certificate) {
  for (const side of [416, 320]) {
    const manifestResponse = await secureRequest(
      `${frontendOrigin}/models/yolo26n-${side}.json`,
      certificate,
    );
    assert.equal(manifestResponse.status, 200);
    const manifest = JSON.parse(manifestResponse.bytes.toString());
    const model = await secureRequest(
      `${frontendOrigin}/models/${manifest.file}`,
      certificate,
    );
    assert.equal(model.status, 200);
    assert.match(
      String(model.headers["content-type"]),
      /application\/octet-stream/,
    );
    assert.equal(model.bytes.length, manifest.bytes);
    assert.equal(
      createHash("sha256").update(model.bytes).digest("hex"),
      manifest.sha256,
    );
  }
  const runtimeResponse = await secureRequest(
    `${frontendOrigin}/ort/manifest.json`,
    certificate,
  );
  assert.equal(runtimeResponse.status, 200);
  const runtime = JSON.parse(runtimeResponse.bytes.toString());
  for (const asset of runtime.files) {
    const response = await secureRequest(
      `${frontendOrigin}/ort/${asset.name}`,
      certificate,
    );
    assert.equal(response.status, 200);
    if (asset.name.endsWith(".wasm"))
      assert.match(
        String(response.headers["content-type"]),
        /application\/wasm/,
      );
    assert.equal(response.bytes.length, asset.bytes);
    assert.equal(
      createHash("sha256").update(response.bytes).digest("hex"),
      asset.sha256,
    );
  }
  for (const path of [
    "/models/not-present.onnx",
    "/ort/not-present.wasm",
    "/not-an-app-route",
  ])
    assert.equal(
      (await secureRequest(frontendOrigin + path, certificate)).status,
      404,
    );
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => abort.abort(new Error("Split smoke interrupted")));

try {
  await stat(join(root, "dist/backend/src/relay.js"));
  temporaryRoot = await mkdtemp(join(tmpdir(), "roadlens-split-"));
  const output = join(temporaryRoot, "frontend");
  const keyFile = join(temporaryRoot, "localhost-key.pem");
  const certificateFile = join(temporaryRoot, "localhost-cert.pem");
  const certificateConfig = join(temporaryRoot, "openssl.cnf");
  // Some Windows OpenSSL distributions have a missing compiled-in default
  // config. Supply this task's minimal config instead of changing global state.
  await writeFile(
    certificateConfig,
    "[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = localhost\n",
  );
  await run(
    process.env.ROADLENS_OPENSSL ?? "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "1",
      "-config",
      certificateConfig,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      keyFile,
      "-out",
      certificateFile,
    ],
    { quiet: true, timeout: 30_000 },
  );
  const key = await readFile(keyFile),
    certificate = await readFile(certificateFile);
  const frontend = https.createServer(
    { key, cert: certificate },
    staticHandler(output),
  );
  const frontendPort = await listen(frontend);
  const frontendOrigin = `https://127.0.0.1:${frontendPort}`;
  const { createRelay } = await import(
    pathToFileURL(join(root, "dist/backend/src/relay.js")).href
  );
  relay = createRelay({ origins: [frontendOrigin] });
  const backendPort = await listen(relay.server);
  const proxy = https.createServer(
    { key, cert: certificate },
    (request, response) => {
      proxyRequests++;
      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: backendPort,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, host: `127.0.0.1:${backendPort}` },
        },
        (incoming) => {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.on("socket", trackSocket);
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      response.once("close", () => upstream.destroy());
      request.pipe(upstream);
    },
  );
  proxy.on("upgrade", (request, socket, head) => {
    proxyUpgrades++;
    const upstream = trackSocket(net.connect(backendPort, "127.0.0.1"));
    const stop = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.once("error", stop);
    upstream.once("error", stop);
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
    upstream.once("connect", () => {
      const headers = [];
      for (let i = 0; i < request.rawHeaders.length; i += 2)
        headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      upstream.write(
        `${request.method} ${request.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  });
  const relayPort = await listen(proxy);
  const relayOrigin = `https://127.0.0.1:${relayPort}`;
  assert.notEqual(frontendOrigin, relayOrigin);
  await run(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "build",
      "--config",
      "frontend/vite.config.ts",
      "--outDir",
      output,
    ],
    {
      env: {
        NODE_ENV: "production",
        VITE_API_BASE_URL: relayOrigin,
        VITE_SHARING_DISABLED: "false",
      },
    },
  );
  const scripts = (await readdir(join(output, "assets"))).filter((name) =>
    name.endsWith(".js"),
  );
  assert(
    (
      await Promise.all(
        scripts.map((name) => readFile(join(output, "assets", name), "utf8")),
      )
    ).some((source) => source.includes(relayOrigin)),
    "Production bundle did not contain the exact HTTPS relay origin",
  );
  await assertAssets(frontendOrigin, certificate);
  const health = await secureRequest(`${relayOrigin}/healthz`, certificate);
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.bytes.toString()).healthy, true);
  assert.equal(JSON.parse(health.bytes.toString()).v, 2);
  const config = await secureRequest(`${relayOrigin}/api/config`, certificate, {
    headers: { Origin: frontendOrigin },
  });
  assert.equal(config.status, 200);
  assert.equal(config.headers["access-control-allow-origin"], frontendOrigin);
  const preflight = await secureRequest(
    `${relayOrigin}/api/rooms`,
    certificate,
    {
      method: "OPTIONS",
      headers: {
        Origin: frontendOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    },
  );
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers["access-control-allow-origin"],
    frontendOrigin,
  );
  await allowedUpgrade(
    `${relayOrigin.replace("https:", "wss:")}/ws`,
    certificate,
    frontendOrigin,
  );
  for (const origin of [
    `https://not-allowed-${randomUUID()}.invalid`,
    "http://localhost:5173",
    `https://localhost:${frontendPort}`,
  ]) {
    assert.equal(
      (
        await secureRequest(`${relayOrigin}/api/config`, certificate, {
          headers: { Origin: origin },
        })
      ).status,
      403,
    );
    await rejectedUpgrade(
      `${relayOrigin.replace("https:", "wss:")}/ws`,
      certificate,
      origin,
    );
  }
  assert.equal(
    (await secureRequest(`${relayOrigin}/api/config`, certificate)).status,
    403,
  );
  console.log(
    "Local split HTTPS production assets, hashes/MIME, CORS and disallowed HTTP/WSS origins passed.",
  );
  if (!checksOnly) {
    const upgradesBefore = proxyUpgrades,
      requestsBefore = proxyRequests;
    await run(
      process.execPath,
      [
        "node_modules/@playwright/test/cli.js",
        "test",
        "--config",
        "playwright.config.ts",
        "--grep",
        "@cloud",
        "--output",
        "test-results/split-production",
      ],
      {
        env: {
          ROADLENS_BASE_URL: frontendOrigin,
          ROADLENS_RELAY_URL: relayOrigin,
          ROADLENS_TEST_LOCAL_TLS: "1",
          ROADLENS_FRONTEND_ONLY: "false",
        },
        timeout: 240_000,
      },
    );
    assert(
      proxyUpgrades - upgradesBefore >= 3,
      "The real three-context flow did not use the separate WSS relay",
    );
    assert(
      proxyRequests > requestsBefore,
      "The paired flow did not use the separate HTTPS relay API",
    );
    assert.equal(
      frontendApiRequests,
      0,
      "The split frontend attempted a same-origin relay request",
    );
    console.log(
      "Local split-origin HTTPS/WSS real-model paired browser smoke passed. This is not cloud or physical-phone verification.",
    );
  } else {
    console.log(
      "Browser flow was explicitly skipped (--checks-only); no browser result is claimed.",
    );
  }
} finally {
  for (const child of children) stopChild(child);
  for (const socket of sockets) socket.destroy();
  if (relay) await relay.close();
  for (const server of servers.reverse())
    if (server.listening)
      await new Promise((resolveClose) => server.close(resolveClose));
  if (temporaryRoot) {
    // Verify the exact resolved task-owned path before recursive cleanup, including on Windows.
    const canonical = await realpath(temporaryRoot);
    const temporaryParent = await realpath(tmpdir());
    assert.equal(
      dirname(canonical).toLowerCase(),
      temporaryParent.toLowerCase(),
    );
    assert(basename(canonical).startsWith("roadlens-split-"));
    await rm(canonical, { recursive: true, force: true });
  }
}
