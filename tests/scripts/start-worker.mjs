// Windows foreground-start acceptance check. Actual cached CUDA warmup and relay
// registration; no camera/network-performance or physical-phone claim.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.equal(process.platform, "win32", "This test exercises Windows console Ctrl+C");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const python = join(root, "worker/.venv/Scripts/python.exe");
const powershell = process.env.ROADLENS_TEST_POWERSHELL || "pwsh.exe";
const secret = randomBytes(32).toString("base64url");
const children = new Set();
let relay;
let temporary;
const controller = String.raw`
import ctypes, os, subprocess, sys, threading, time
from ctypes import wintypes
import psutil
si=subprocess.STARTUPINFO();si.dwFlags|=subprocess.STARTF_USESHOWWINDOW;si.wShowWindow=0
child=subprocess.Popen([sys.argv[1],'-NoProfile','-NonInteractive','-File',sys.argv[3],'-ConfigPath',sys.argv[4]],cwd=sys.argv[2],
    stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace',
    creationflags=subprocess.CREATE_NEW_CONSOLE,startupinfo=si)
owned=[]
def output():
    for line in child.stdout:print(line,end='',flush=True)
reader=threading.Thread(target=output,daemon=True);reader.start()
try:
    command=sys.stdin.readline().strip()
    if command!='interrupt':raise RuntimeError('Expected test interrupt command')
    if child.poll() is not None:raise RuntimeError('Foreground process exited before interruption')
    parent=psutil.Process(child.pid);owned=parent.children(recursive=True)+[parent]
    identities={p.pid:p.create_time() for p in owned}
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.FreeConsole()
    if not kernel.AttachConsole(child.pid):raise RuntimeError('Cannot attach owned test console')
    entries=(wintypes.DWORD*32)()
    count=kernel.GetConsoleProcessList(entries,32)
    if not 0<count<=32 or not set(entries[:count])<=set(identities)|{os.getpid()}:
        raise RuntimeError('Console contains a process outside the owned test tree')
    if not kernel.SetConsoleCtrlHandler(None,True):raise RuntimeError('Cannot protect controller from own test signal')
    if not kernel.GenerateConsoleCtrlEvent(0,0):raise RuntimeError('Cannot deliver CTRL_C_EVENT')
    time.sleep(.2);kernel.FreeConsole()
    child.wait(timeout=20)
    gone,alive=psutil.wait_procs(owned,timeout=20)
    if alive:raise RuntimeError('Owned descendants survived foreground Ctrl+C')
    reader.join(timeout=3)
    print('ROADLENS_START_TEST_CLEAN_EXIT',child.returncode,flush=True)
except Exception as error:
    print('ROADLENS_START_TEST_FAILURE',type(error).__name__,str(error),flush=True)
    raise SystemExit(1)
finally:
    # Only the exact processes captured beneath this newly created PowerShell.
    if child.poll() is None:
        try:owned=psutil.Process(child.pid).children(recursive=True)+[psutil.Process(child.pid)]
        except psutil.NoSuchProcess:pass
    for process in owned:
        try:
            if process.is_running():process.kill()
        except psutil.NoSuchProcess:pass
`;

function launch(command, args, env) {
  const child = spawn(command, args, { cwd: temporary, env: { ...process.env, ...env, PYTHONIOENCODING: "utf-8" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk.toString()).slice(-32000); });
  const done = new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", code => resolveExit(code)); });
  return { child, done, output: () => output };
}
async function waitFor(predicate, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    assert(Date.now() < deadline, "Startup test deadline exceeded");
    await new Promise(done => setTimeout(done, 100));
  }
}
function assertSafe(output) {
  assert(!output.includes(secret), "Machine secret appeared in captured output");
  assert(!output.includes("Collecting "), "Normal start attempted package installation");
  assert(!output.includes("TensorRT export"), "Normal start attempted engine rebuild");
}
try {
  temporary = await mkdtemp(join(tmpdir(), "roadlens-start-test-"));
  // Explicitly select a nonexistent path in this test's own directory. No user
  // configuration file is read, changed, renamed, backed up or removed.
  const configPath = join(temporary, "inherited-only.env");
  assert.equal(relative(temporary, configPath), "inherited-only.env");
  assert(!existsSync(configPath));
  const { createRelay } = await import(pathToFileURL(join(root, "dist/backend/src/relay.js")).href);
  relay = createRelay({ origins: ["https://start-script.test"], workerSecret: secret });
  await new Promise(done => relay.server.listen(0, "127.0.0.1", done));
  const port = relay.server.address().port;
  const env = { ROADLENS_RELAY_URL: `ws://127.0.0.1:${port}/worker`, ROADLENS_WORKER_SECRET: secret,
    ROADLENS_ALLOW_LOOPBACK: "true", ROADLENS_MODEL_MODE: "balanced", ROADLENS_GPU_RUNTIME: "pytorch_cuda",
    ROADLENS_GPU_DEVICE: "0", ALLOW_WORKER_CPU_FALLBACK: "false" };
  for (const invalid of [{ ROADLENS_WORKER_SECRET: "" }, { ROADLENS_RELAY_URL: `wss://relay.invalid/worker?secret=${secret}` }]) {
    const test = launch(powershell, ["-NoProfile", "-NonInteractive", "-File", join(root, "start.ps1"), "-ConfigPath", configPath], { ...env, ...invalid });
    await waitFor(() => test.child.exitCode !== null, 15000);
    assert.notEqual(await test.done, 0, "Invalid configuration must fail");
    assertSafe(test.output());
    assert(!test.output().includes("GPU warmup passed"), "Bad configuration reached GPU startup");
  }
  console.log("PASS: two invalid configurations fail safely from a nonproject directory.");
  const test = launch(python, ["-u", "-c", controller, powershell, temporary, join(root, "start.ps1"), configPath], env);
  await waitFor(() => {
    assert(test.child.exitCode === null, "Startup controller exited before GPU readiness");
    return test.output().includes("GPU WORKER READY");
  });
  const config = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { Origin: "https://start-script.test" } }).then(response => response.json());
  assert.equal(config.gpu.state, "ready");
  assertSafe(test.output());
  console.log("PASS: start.ps1 warmed actual balanced CUDA model and authenticated with the actual compiled relay.");
  test.child.stdin.end("interrupt\n");
  await waitFor(() => test.child.exitCode !== null, 50000);
  assert.equal(await test.done, 0, test.output().replaceAll(secret, "[redacted]"));
  assert(test.output().includes("GPU worker stopped"), "Worker did not emit cooperative cleanup marker");
  assert(test.output().includes("ROADLENS_START_TEST_CLEAN_EXIT"), "Console tree did not exit cleanly");
  assertSafe(test.output());
  await waitFor(() => relay.stats().gpu.sockets === 0, 5000);
  console.log("PASS: real CTRL_C_EVENT stopped the foreground worker and all owned descendants; relay socket cleared.");
} finally {
  for (const child of children) if (child.exitCode === null && child.pid) {
    // Failing-test fallback only; this PID was created by this harness.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  }
  if (relay) await relay.close();
  if (temporary) {
    const resolved = await realpath(temporary);
    const base = await realpath(tmpdir());
    const path = relative(base, resolved);
    assert(path.startsWith("roadlens-start-test-") && !path.includes("..") && !path.includes("\\") && !path.includes("/"));
    await rm(resolved, { recursive: true });
  }
}
