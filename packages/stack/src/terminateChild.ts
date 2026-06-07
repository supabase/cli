interface ChildLike {
  readonly pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean | void;
  once: (event: "exit", listener: () => void) => void;
  off: (event: "exit", listener: () => void) => void;
}

export const terminateChildProcess = async (
  child: ChildLike,
  opts: {
    readonly timeoutMs?: number;
  } = {},
): Promise<void> => {
  if (child.pid == null) {
    return;
  }

  const timeoutMs = opts.timeoutMs ?? 1_000;

  const termExit = waitForChildExit(child, timeoutMs);
  try {
    child.kill("SIGTERM");
  } catch {}

  if (await termExit) {
    return;
  }

  const killExit = waitForChildExit(child, timeoutMs);
  try {
    child.kill("SIGKILL");
  } catch {}

  await killExit;
};

function waitForChildExit(child: ChildLike, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onExit = () => {
      cleanup();
      resolve(true);
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };

    child.once("exit", onExit);
  });
}
