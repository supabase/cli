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

/**
 * Waits for a child exit event while making listener ownership explicit. The
 * callback adapter removes the listener on both completion and interruption;
 * the timeout is an Effect race, so no timer survives a losing branch.
 */
const signalAndWait = (
  child: ChildLike,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Effect.Effect<boolean> =>
  Effect.raceFirst(
    Effect.callback<boolean>((resume) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        child.off("exit", onExit);
      };
      const onExit = () => {
        cleanup();
        resume(Effect.succeed(true));
      };

      if (hasAlreadyExited(child)) {
        resume(Effect.succeed(true));
        return Effect.void;
      }
      child.once("exit", onExit);
      try {
        child.kill(signal);
      } catch {
        // A child can disappear between the state check and kill call.
      }
      return Effect.sync(cleanup);
    }),
    Effect.as(Effect.sleep(Duration.millis(timeoutMs)), false),
  );

export const terminateChildProcess = (
  child: ChildLike,
  opts: {
    readonly timeoutMs?: number;
  } = {},
): Effect.Effect<void> => {
  if (child.pid == null || hasAlreadyExited(child)) return Effect.void;

  const timeoutMs = opts.timeoutMs ?? 1_000;
  return Effect.gen(function* () {
    if (yield* signalAndWait(child, "SIGTERM", timeoutMs)) return;
    if (hasAlreadyExited(child)) return;
    yield* signalAndWait(child, "SIGKILL", timeoutMs);
  });
};
