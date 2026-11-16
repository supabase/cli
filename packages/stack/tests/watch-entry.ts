import { Effect, Path } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem.watch's async stat before attaching makes attachment unobservable.
import { existsSync, watch } from "node:fs";

/**
 * Watches `entry` under `directory` and returns, within the caller's scope, an effect that
 * completes once the entry's existence equals `present`. Subscribe before triggering the change,
 * then await the returned effect after the trigger: attaching the watcher happens synchronously
 * here, and existence is only checked afterward, so no event between attachment and the trigger
 * can be missed. This does not use `FileSystem.watch`: its `stat` runs asynchronously before the
 * underlying `fs.watch` attaches, so attachment itself is unobservable and an event in that gap
 * is lost until the caller's timeout fires.
 */
export const watchEntry = Effect.fn("Test.watchEntry")(function* (
  directory: string,
  entry: string,
  present: boolean,
) {
  const path = yield* Path.Path;
  const target = path.join(directory, entry);
  const listeners = new Set<() => void>();
  yield* Effect.acquireRelease(
    Effect.sync(() => watch(directory, () => listeners.forEach((listener) => listener()))),
    (watcher) => Effect.sync(() => watcher.close()),
  );
  return yield* Effect.succeed(
    Effect.callback<void>((resume) => {
      const check = () => {
        if (existsSync(target) === present) resume(Effect.void);
      };
      check();
      listeners.add(check);
      return Effect.sync(() => {
        listeners.delete(check);
      });
    }),
  );
});
