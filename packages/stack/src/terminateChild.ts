import { Duration, Effect } from "effect";

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

const terminateWithSignal = (
  child: ChildLike,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Effect.Effect<boolean> =>
  Effect.raceFirst(
    Effect.callback<boolean>((resume) => {
      let cleaned = false;
      const onExit = () => {
        cleanup();
        resume(Effect.succeed(true));
      };
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        child.off("exit", onExit);
      };

      child.once("exit", onExit);
      if (hasAlreadyExited(child)) {
        onExit();
      } else {
        try {
          child.kill(signal);
        } catch {
          // A child may disappear between the exit check and kill. The timeout
          // stage still bounds this wait, and the next stage rechecks state.
        }
      }

      return Effect.sync(cleanup);
    }),
    Effect.sleep(Duration.millis(timeoutMs)).pipe(Effect.as(false)),
  );

export const terminateChildProcess = (
  child: ChildLike,
  opts: {
    readonly timeoutMs?: number;
  } = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (child.pid == null || hasAlreadyExited(child)) {
      return;
    }

    const timeoutMs = opts.timeoutMs ?? 1_000;
    if (yield* terminateWithSignal(child, "SIGTERM", timeoutMs)) {
      return;
    }
    if (hasAlreadyExited(child)) {
      return;
    }

    yield* terminateWithSignal(child, "SIGKILL", timeoutMs);
  });
