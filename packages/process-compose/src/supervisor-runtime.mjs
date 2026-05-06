import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";

const encodedConfig = process.argv[2];

if (encodedConfig == null) {
  throw new Error("Missing supervisor config");
}

const config = JSON.parse(Buffer.from(encodedConfig, "base64url").toString("utf8"));

const isWindows = process.platform === "win32";
const child = spawn(config.command, config.args ?? [], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  detached: !isWindows,
});

if (child.stdout != null) {
  child.stdout.pipe(process.stdout);
}

if (child.stderr != null) {
  child.stderr.pipe(process.stderr);
}

const childExited = new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

let shuttingDown = false;
let ownerWatcher;

const waitForChildExit = async (timeoutMs) => {
  let timeoutId;

  try {
    return await Promise.race([
      childExited.then(() => true),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId);
    }
  }
};

const killChildTree = (signal) => {
  if (child.pid == null) {
    return;
  }

  if (isWindows) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5_000,
      });
    } catch {}

    return;
  }

  try {
    process.kill(-child.pid, signal);
    return;
  } catch {}

  try {
    process.kill(child.pid, signal);
  } catch {}
};

const runCleanup = () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const removePathWithRetry = async (action) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(action.path, {
          recursive: action.recursive ?? true,
          force: action.force ?? true,
        });
        return;
      } catch {}

      await sleep(250);
    }
  };

  return Promise.all(
    (config.cleanup ?? []).map(async (action) => {
      try {
        if (action._tag === "DockerRemove") {
          execFileSync("docker", ["rm", "-f", action.containerName], {
            stdio: "ignore",
            timeout: 5_000,
          });
        } else if (action._tag === "RemovePath") {
          await removePathWithRetry(action);
        }
      } catch {}
    }),
  ).then(() => undefined);
};

const shutdown = async (signal) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  if (ownerWatcher != null) {
    clearInterval(ownerWatcher);
  }
  killChildTree(signal);

  const exitedGracefully = await waitForChildExit(config.shutdownTimeoutMs ?? 10_000);
  if (!exitedGracefully) {
    killChildTree("SIGKILL");
    await waitForChildExit(2_000);
  }

  await runCleanup();
  process.exit(0);
};

process.stdin.resume();
process.stdin.on("end", () => {
  void shutdown(config.shutdownSignal ?? "SIGTERM");
});
process.stdin.on("close", () => {
  void shutdown(config.shutdownSignal ?? "SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

const ownerPid = typeof config.ownerPid === "number" ? config.ownerPid : undefined;
const ownerAlive = () => {
  if (ownerPid == null) {
    return true;
  }

  try {
    process.kill(ownerPid, 0);
    return true;
  } catch {
    return false;
  }
};

if (!ownerAlive()) {
  void shutdown(config.shutdownSignal ?? "SIGTERM");
} else {
  ownerWatcher = setInterval(() => {
    if (!ownerAlive()) {
      void shutdown(config.shutdownSignal ?? "SIGTERM");
    }
  }, 500);
  ownerWatcher.unref?.();
}

void childExited.then(async ({ code, signal }) => {
  if (shuttingDown) {
    return;
  }

  if (!ownerAlive() || (config.cleanup?.length ?? 0) > 0) {
    await runCleanup();
    process.exit(0);
    return;
  }

  if (signal != null) {
    process.exit(1);
    return;
  }

  process.exit(code ?? 0);
});
