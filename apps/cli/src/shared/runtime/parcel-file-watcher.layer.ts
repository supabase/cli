import type * as ParcelWatcher from "@parcel/watcher";
import { Cause, Effect, Layer, Queue, Stream } from "effect";

import {
  FileWatcher,
  FileWatcherError,
  type FileWatchEvent,
  type FileWatchOptions,
} from "./file-watcher.service.ts";

function toParcelOptions(options?: FileWatchOptions): ParcelWatcher.Options | undefined {
  if (options?.ignore === undefined) {
    return undefined;
  }
  return {
    ignore: [...options.ignore],
  };
}

// `@parcel/watcher` loads a native `.node` binding at module-import time. Keep
// the import dynamic so merely registering this layer in the command tree does
// not pull the native binding into every CLI invocation — only commands that
// actually subscribe (e.g. `functions dev`) hit the native binding path.
const loadParcelWatcher = (): Promise<typeof ParcelWatcher> => import("@parcel/watcher");

export const parcelFileWatcherLayer = Layer.sync(FileWatcher, () =>
  FileWatcher.of({
    watch: (path, options) =>
      Stream.callback<ReadonlyArray<FileWatchEvent>, FileWatcherError>((queue) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              const parcel = await loadParcelWatcher();
              return parcel.subscribe(
                path,
                (error, events) => {
                  if (error !== null) {
                    Queue.failCauseUnsafe(
                      queue,
                      Cause.fail(new FileWatcherError({ path, cause: error })),
                    );
                    return;
                  }
                  Queue.offerUnsafe(queue, events);
                },
                toParcelOptions(options),
              );
            },
            catch: (cause) => new FileWatcherError({ path, cause }),
          }),
          (subscription) =>
            Effect.promise(() => subscription.unsubscribe()).pipe(
              Effect.ignore({ log: true, message: "Failed to unsubscribe file watcher" }),
            ),
        ),
      ),
  }),
);
