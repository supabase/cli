import type { Stream } from "effect";
import { Data, Context } from "effect";

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

export interface FileWatchOptions {
  readonly ignore?: ReadonlyArray<string>;
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
