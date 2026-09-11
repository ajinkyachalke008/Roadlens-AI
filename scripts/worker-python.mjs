import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const python = fileURLToPath(
  new URL(
    process.platform === "win32"
      ? "../worker/.venv/Scripts/python.exe"
      : "../worker/.venv/bin/python",
    import.meta.url,
  ),
);
if (!existsSync(python)) {
  console.error(
    "Worker environment is missing. Run the documented setup-worker.ps1 first.",
  );
  process.exitCode = 1;
} else {
  const child = spawn(python, process.argv.slice(2), {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", () => {
    console.error("Could not start the isolated worker interpreter.");
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
