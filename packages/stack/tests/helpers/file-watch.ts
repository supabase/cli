// oxlint-disable effecttsgo/node-builtin-import -- Tests intentionally exercise native async, HTTP, timer, and subprocess boundaries.
import { watch, type FSWatcher } from "node:fs";

/**
 * Watches a directory and re-arms when the runtime reports a transient ENOENT
 * while an entry disappears during a scan. Returns a close function.
 */
export const watchDirectoryWithRetry = (
  directory: string,
  onEvent: () => void,
  onError: (cause: unknown) => void,
): (() => void) => {
  let watcher: FSWatcher | undefined;
  let closed = false;
  const arm = () => {
    if (closed) return;
    try {
      watcher = watch(directory, onEvent);
      watcher.once("error", (cause) => {
        watcher?.close();
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
          arm();
          onEvent();
          return;
        }
        onError(cause);
      });
    } catch (cause) {
      closed = true;
      onError(cause);
    }
  };
  arm();
  return () => {
    closed = true;
    watcher?.close();
  };
};
