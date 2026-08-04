import { createStack } from "../../src/node.ts";

// Registered before any bring-up work: the spawning harness SIGTERMs a stack
// that misses its readiness deadline, and without these the default signal
// disposition kills the process mid-start with temp dirs and containers left
// behind for the leak check to trip over. A pre-readiness signal is remembered
// and honored at the next await boundary via a dispose-then-exit.
let earlyShutdownRequested = false;
const onEarlySignal = () => {
  earlyShutdownRequested = true;
};
process.once("SIGINT", onEarlySignal);
process.once("SIGTERM", onEarlySignal);

const parentPid = readParentPid(process.argv.slice(2));
const stack = await createStack();
if (earlyShutdownRequested) {
  await stack.dispose();
  process.exit(0);
}
await stack.start();
if (earlyShutdownRequested) {
  await stack.dispose();
  process.exit(0);
}
process.off("SIGINT", onEarlySignal);
process.off("SIGTERM", onEarlySignal);

// Signal readiness to parent process
console.log(JSON.stringify({ url: stack.url, dbUrl: stack.dbUrl }));

await waitForShutdown(parentPid);
await stack.dispose();
process.exit(0);

function waitForShutdown(parentPid: number | undefined): Promise<void> {
  return new Promise((resolve) => {
    const onShutdown = () => {
      cleanup();
      resolve();
    };

    const onParentExit = () => {
      onShutdown();
    };

    const parentWatchdog =
      parentPid == null
        ? undefined
        : setInterval(() => {
            if (!isProcessAlive(parentPid)) {
              onParentExit();
            }
          }, 250);

    parentWatchdog?.unref();

    const cleanup = () => {
      process.off("SIGINT", onShutdown);
      process.off("SIGTERM", onShutdown);
      process.off("disconnect", onParentExit);
      if (parentWatchdog != null) {
        clearInterval(parentWatchdog);
      }
    };

    process.once("SIGINT", onShutdown);
    process.once("SIGTERM", onShutdown);
    process.once("disconnect", onParentExit);
  });
}

function readParentPid(argv: ReadonlyArray<string>): number | undefined {
  const flagIndex = argv.indexOf("--parent-pid");
  const rawValue = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  if (rawValue == null) {
    return undefined;
  }

  const value = Number.parseInt(rawValue, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
