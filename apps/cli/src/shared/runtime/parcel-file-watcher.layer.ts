import * as ParcelWatcher from "@parcel/watcher";
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

export const parcelFileWatcherLayer = Layer.sync(FileWatcher, () =>
  FileWatcher.of({
    watch: (path, options) =>
      Stream.callback<ReadonlyArray<FileWatchEvent>, FileWatcherError>((queue) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              ParcelWatcher.subscribe(
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
              ),
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
