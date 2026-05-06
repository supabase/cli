import { createStack } from "../../src/node.ts";

const parentPid = readParentPid(process.argv.slice(2));
const stack = await createStack();
await stack.start();

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
