import { Cause, Effect, Layer, Queue, Stream } from "effect";
import { createWrapper } from "@parcel/watcher/wrapper";
import type ParcelWatcher from "@parcel/watcher";

import {
  FileWatcher,
  FileWatcherError,
  type FileWatchEvent,
  type FileWatchOptions,
} from "./file-watcher.service.ts";

declare const SUPABASE_LIBC: string | undefined;

function wrapBinding(binding: unknown): typeof import("@parcel/watcher") {
  return createWrapper(binding);
}

function loadParcelWatcher(): typeof import("@parcel/watcher") {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") {
      return wrapBinding(require("@parcel/watcher-darwin-arm64"));
    }
    if (process.arch === "x64") {
      return wrapBinding(require("@parcel/watcher-darwin-x64"));
    }
  }

  if (process.platform === "linux") {
    if (process.arch === "arm64") {
      if (typeof SUPABASE_LIBC !== "undefined" && SUPABASE_LIBC === "musl") {
        return wrapBinding(require("@parcel/watcher-linux-arm64-musl"));
      }
      return wrapBinding(require("@parcel/watcher-linux-arm64-glibc"));
    }
    if (process.arch === "x64") {
      if (typeof SUPABASE_LIBC !== "undefined" && SUPABASE_LIBC === "musl") {
        return wrapBinding(require("@parcel/watcher-linux-x64-musl"));
      }
      return wrapBinding(require("@parcel/watcher-linux-x64-glibc"));
    }
  }

  if (process.platform === "win32") {
    if (process.arch === "arm64") {
      return wrapBinding(require("@parcel/watcher-win32-arm64"));
    }
    if (process.arch === "x64") {
      return wrapBinding(require("@parcel/watcher-win32-x64"));
    }
  }

  throw new Error(`Unsupported @parcel/watcher platform: ${process.platform}-${process.arch}`);
}

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
      Stream.callback<ReadonlyArray<FileWatchEvent>, FileWatcherError>((queue) => {
        const watcher = loadParcelWatcher();
        return Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              watcher.subscribe(
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
        );
      }),
  }),
);
