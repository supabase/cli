interface ChildLike {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean | void;
  once: (event: "exit", listener: () => void) => void;
  off: (event: "exit", listener: () => void) => void;
}

const hasAlreadyExited = (child: ChildLike): boolean =>
  child.exitCode != null || child.signalCode != null;

export const terminateChildProcess = async (
  child: ChildLike,
  opts: {
    readonly timeoutMs?: number;
  } = {},
): Promise<void> => {
  if (child.pid == null) {
    return;
  }
  // An already-exited child never fires another `exit` event, so the waits
  // below would burn their full SIGTERM + SIGKILL timeouts listening for one.
  if (hasAlreadyExited(child)) {
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
  if (hasAlreadyExited(child)) {
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
