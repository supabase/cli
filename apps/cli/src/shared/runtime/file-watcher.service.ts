import type { Stream } from "effect";
import { Data, ServiceMap } from "effect";

export type FileWatchEventType = "create" | "update" | "delete";

export interface FileWatchEvent {
  readonly path: string;
  readonly type: FileWatchEventType;
}

export interface FileWatchOptions {
  readonly ignore?: ReadonlyArray<string>;
}

export class FileWatcherError extends Data.TaggedError("FileWatcherError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

interface FileWatcherShape {
  readonly watch: (
    path: string,
    options?: FileWatchOptions,
  ) => Stream.Stream<ReadonlyArray<FileWatchEvent>, FileWatcherError>;
}

export class FileWatcher extends ServiceMap.Service<FileWatcher, FileWatcherShape>()(
  "supabase/runtime/FileWatcher",
) {}
