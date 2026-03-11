#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
const [, , entrypoint, ...args] = process.argv;

if (entrypoint == null) {
  throw new Error("Missing CLI entrypoint");
}

const child = spawn("bun", [entrypoint, ...args], {
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

  // Bun currently exits too abruptly under direct source execution to
  // allow async cleanup. Route outer termination through a non-terminating
  // signal that the source CLI translates into its normal `stack.dispose()`
  // path, then wait for it to exit on its own.
  if (process.platform !== "win32") {
    try {
      child.kill("SIGWINCH");
    } catch {
      child.stdin?.end();
    }
  } else {
    child.stdin?.end();
  }

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
