#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const [, , shim, ...args] = process.argv;

if (shim == null) {
  throw new Error("Missing CLI shim entrypoint");
}

const child = spawn("node", [shim, ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  detached: true,
});

const forward = (stream, target) => {
  if (stream == null) {
    return;
  }

  stream.on("data", (chunk) => {
    if (!target.write(chunk)) {
      stream.pause();
    }
  });
  target.on("drain", () => {
    stream.resume();
  });
};

forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

let forwardedShutdown = false;
let forceKillTimer;

const stopChildGracefully = () => {
  if (forwardedShutdown) {
    return;
  }

  forwardedShutdown = true;

  // The compiled Bun binary exits too abruptly under direct SIGTERM to allow
  // async cleanup. Closing stdin lets the CLI's `awaitShutdown` finalizer run
  // through the normal `stack.dispose()` path before exit. SIGWINCH is sent as
  // a non-terminating wake-up in case the CLI is blocked elsewhere.
  if (process.platform !== "win32") {
    try {
      child.kill("SIGWINCH");
    } catch {}
  }
  try {
    child.stdin?.end();
  } catch {}

  forceKillTimer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 15_000);
  forceKillTimer.unref();
};

const relaySignal = () => {
  stopChildGracefully();
};

process.once("SIGTERM", relaySignal);
process.once("SIGINT", relaySignal);
process.once("SIGHUP", relaySignal);

child.once("close", (code, signal) => {
  if (forceKillTimer != null) {
    clearTimeout(forceKillTimer);
  }

  if (signal != null) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

process.stdin.resume();
process.stdin.on("end", stopChildGracefully);
process.stdin.on("close", stopChildGracefully);
