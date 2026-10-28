import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerFiles = ["line-notification-worker.mjs", "market-scan-worker.mjs"];
const workerDirectory = path.dirname(fileURLToPath(import.meta.url));
const children: ChildProcess[] = [];
let stopping = false;

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

function failWorker(file: string, reason: string): void {
  if (stopping) return;
  console.error(`Worker ${file} stopped unexpectedly: ${reason}`);
  process.exitCode = 1;
  stop("SIGTERM");
  const forceExit = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);
  forceExit.unref();
}

for (const file of workerFiles) {
  const child = spawn(process.execPath, [path.join(workerDirectory, file)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  children.push(child);
  child.once("error", (error) => failWorker(file, error.message));
  child.once("exit", (code, signal) => {
    if (!stopping) failWorker(file, `exit=${code ?? "null"} signal=${signal ?? "none"}`);
  });
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
