import { existsSync, watch } from "node:fs";
import { resolve } from "node:path";
import { Cause, Context, Data, Effect, Layer, Queue, Stream } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

type FileWatchEventType = "create" | "update" | "delete";

export interface FileWatchEvent {
  readonly path: string;
  readonly type: FileWatchEventType;
}

interface FileWatchOptions {
  readonly ignore?: ReadonlyArray<string>;
  readonly recursive?: boolean;
}

export class FileWatcherError extends Data.TaggedError("FileWatcherError")<{
  readonly path: string;
  readonly cause: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

interface FileWatcherShape {
  readonly watch: (
    path: string,
    options?: FileWatchOptions,
  ) => Stream.Stream<ReadonlyArray<FileWatchEvent>, FileWatcherError>;
}

export class FileWatcher extends Context.Service<FileWatcher, FileWatcherShape>()(
  "supabase/runtime/FileWatcher",
) {}

// The platform watcher drops null-name events and classifies relative names asynchronously.
// This native service boundary preserves the CLI's root events and synchronous event order.
export const fileWatcherLayer = Layer.sync(FileWatcher, () =>
  FileWatcher.of({
    watch: (root, options) =>
      Stream.callback<ReadonlyArray<FileWatchEvent>, FileWatcherError>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const recursive = options?.recursive ?? true;
            const watcher = watch(root, { recursive }, (eventType, filename) => {
              const pathname =
                filename === null || filename === undefined || filename.length === 0
                  ? root
                  : resolve(root, filename.toString());
              // `fs.watch` only distinguishes "rename" (create/delete/rename)
              // from "change" (write); an existence check on "rename"
              // disambiguates create vs delete, "change" always means update.
              const type: FileWatchEvent["type"] =
                eventType === "rename" ? (existsSync(pathname) ? "create" : "delete") : "update";
              Queue.offerUnsafe(queue, [{ path: pathname, type }]);
            });
            watcher.on("error", (cause) => {
              Queue.failCauseUnsafe(queue, Cause.fail(new FileWatcherError({ path: root, cause })));
            });
            return watcher;
          }),
          (watcher) =>
            Effect.sync(() => {
              watcher.close();
            }),
        ),
      ),
  }),
);
