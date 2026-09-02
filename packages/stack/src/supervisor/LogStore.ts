import {
  Data,
  DateTime,
  Effect,
  FileSystem,
  Path,
  Predicate,
  PubSub,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import {
  StackLogEntrySchema,
  type LogCursor,
  type LogOptions,
  type StackLogEntry,
  type StackLogSource,
} from "../public/Logs.ts";
import { redactKnownSecrets } from "../state/SecretStore.ts";

const CURSOR_PREFIX = "v1_";

/** File or decoding failure while opening or writing retained logs. */
export class LogStoreError extends Data.TaggedError("LogStoreError")<{
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface LogStoreOptions {
  /** Explicit owner-only retained log file. */
  readonly path: string;
  /** Maximum number of retained records. Defaults to 1,000. */
  readonly maxEntries?: number;
  /** Maximum encoded retained document size. Defaults to 1 MiB. */
  readonly maxBytes?: number;
  /** Exact values redacted before persistence and publication. */
  readonly knownSecrets?: ReadonlyArray<string>;
}

export interface LogRecord {
  readonly timestamp?: string;
  readonly source: StackLogSource;
  readonly stream: StackLogEntry["stream"];
  readonly message: string;
}

export interface LogStore {
  readonly path: string;
  readonly append: (record: LogRecord) => Effect.Effect<StackLogEntry, LogStoreError>;
  /** Returns retained records selected by cursor and capability filter. */
  readonly read: (
    options?: LogOptions,
  ) => Effect.Effect<ReadonlyArray<StackLogEntry>, LogStoreError>;
  /**
   * Returns retained records followed by live records when `follow` is true.
   * Subscription creation and retained snapshotting happen in one critical
   * section with append, so no entry can be lost or observed twice at handoff.
   */
  readonly stream: (options?: LogOptions) => Stream.Stream<StackLogEntry, LogStoreError>;
}

interface LogDocument {
  readonly nextCursor: number;
  readonly entries: ReadonlyArray<StackLogEntry>;
}

const emptyDocument = (): LogDocument => ({
  nextCursor: 1,
  entries: [],
});

const fileError = (path: string, message: string, cause?: unknown) =>
  new LogStoreError({ path, message, ...(cause === undefined ? {} : { cause }) });

const opaqueCursor = (value: number): LogCursor => ({
  opaque: `${CURSOR_PREFIX}${value.toString(36)}`,
});

const parseOpaqueCursor = (path: string, opaque: string): Effect.Effect<number, LogStoreError> => {
  if (!/^v1_[0-9a-z]+$/.test(opaque)) return Effect.fail(fileError(path, "Log cursor is invalid"));
  const value = Number.parseInt(opaque.slice(CURSOR_PREFIX.length), 36);
  return Number.isSafeInteger(value) && value > 0
    ? Effect.succeed(value)
    : Effect.fail(fileError(path, "Log cursor is out of range"));
};

const decodeCursor = (
  path: string,
  cursor: LogCursor | undefined,
): Effect.Effect<number | undefined, LogStoreError> => {
  if (cursor === undefined) return Effect.as(Effect.void, undefined);
  return parseOpaqueCursor(path, cursor.opaque);
};

const selected = (
  entries: ReadonlyArray<StackLogEntry>,
  options: LogOptions | undefined,
  path: string,
): Effect.Effect<ReadonlyArray<StackLogEntry>, LogStoreError> =>
  Effect.map(decodeCursor(path, options?.cursor), (after) => {
    const capabilities =
      options?.capabilities === undefined ? undefined : new Set(options.capabilities);
    return entries.filter((entry) => {
      const value = Number.parseInt(entry.cursor.opaque.slice(CURSOR_PREFIX.length), 36);
      if (after !== undefined && value <= after) return false;
      if (capabilities === undefined) return true;
      return (
        entry.source !== "gateway" &&
        entry.source !== "supervisor" &&
        capabilities.has(entry.source)
      );
    });
  });

const validateDocument = (
  path: string,
  document: LogDocument,
): Effect.Effect<LogDocument, LogStoreError> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(document.nextCursor) || document.nextCursor < 1)
      return yield* fileError(path, "Retained log next cursor is invalid");
    let previous = 0;
    for (const entry of document.entries) {
      const cursor = yield* parseOpaqueCursor(path, entry.cursor.opaque);
      if (!Number.isSafeInteger(cursor) || cursor <= previous)
        return yield* fileError(path, "Retained log cursors are not strictly increasing");
      previous = cursor;
    }
    if (document.nextCursor <= previous)
      return yield* fileError(path, "Retained log next cursor is not ahead of entries");
    return document;
  });

const readDocument = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<LogDocument, LogStoreError> => {
  const parse = (text: string, sourcePath: string) => {
    const rawLines = text.split(/\r?\n/);
    // A process crash can leave one unterminated tail after an append. Keep all complete JSONL
    // records and drop only that final tail; a file containing no complete record remains an error.
    const hasCompleteTail = text.endsWith("\n");
    const lines = (
      hasCompleteTail || rawLines.length === 1 ? rawLines : rawLines.slice(0, -1)
    ).filter((line) => line.length > 0);
    return Effect.forEach(lines, (line) =>
      Schema.decodeEffect(Schema.fromJsonString(StackLogEntrySchema))(line).pipe(
        Effect.mapError((cause) => fileError(sourcePath, "Retained log file is malformed", cause)),
      ),
    ).pipe(
      Effect.flatMap((entries) => {
        const nextCursor = entries.reduce(
          (next, entry) => Math.max(next, Number.parseInt(entry.cursor.opaque.slice(3), 36) + 1),
          1,
        );
        return validateDocument(sourcePath, { nextCursor, entries });
      }),
    );
  };
  return fs.readFileString(path).pipe(
    Effect.flatMap((text) => {
      return parse(text, path);
    }),
    Effect.catchTag("PlatformError", (error) =>
      Predicate.isTagged(error.reason, "NotFound")
        ? fs.readFileString(`${path}.1`).pipe(
            Effect.flatMap((text) => parse(text, `${path}.1`)),
            Effect.catchTag("PlatformError", (backupError) =>
              Predicate.isTagged(backupError.reason, "NotFound")
                ? Effect.succeed(emptyDocument())
                : Effect.fail(fileError(path, "Unable to read retained log file", backupError)),
            ),
          )
        : Effect.fail(fileError(path, "Unable to read retained log file", error)),
    ),
  );
};

/** Read retained entries without opening or mutating a LogStore. */
export const readRetainedLogs = (
  fs: FileSystem.FileSystem,
  path: string,
  options?: LogOptions,
): Effect.Effect<ReadonlyArray<StackLogEntry>, LogStoreError> =>
  readDocument(fs, path).pipe(
    Effect.flatMap((document) => selected(document.entries, options, path)),
  );

const redactDocument = (
  document: LogDocument,
  knownSecrets: ReadonlyArray<string>,
): { readonly document: LogDocument; readonly changed: boolean } => {
  let changed = false;
  const entries = document.entries.map((entry) => {
    const message = redactKnownSecrets(entry.message, knownSecrets);
    if (message !== entry.message) changed = true;
    return message === entry.message ? entry : { ...entry, message };
  });
  return { document: { ...document, entries }, changed };
};

const encodedEntry = (entry: StackLogEntry, path: string): Effect.Effect<string, LogStoreError> =>
  Schema.encodeEffect(Schema.fromJsonString(StackLogEntrySchema))(entry).pipe(
    Effect.mapError((cause) => fileError(path, "Unable to encode retained logs", cause)),
  );

const encodedSize = (
  entries: ReadonlyArray<StackLogEntry>,
  path: string,
): Effect.Effect<number, LogStoreError> =>
  Effect.forEach(entries, (entry) => encodedEntry(entry, path), { concurrency: "unbounded" }).pipe(
    Effect.map(
      (lines) =>
        new TextEncoder().encode(lines.join("\n") + (lines.length > 0 ? "\n" : "")).byteLength,
    ),
  );

const bounded = (
  document: LogDocument,
  maxEntries: number,
  maxBytes: number,
  path: string,
  initialBytes?: number,
): Effect.Effect<{ readonly document: LogDocument; readonly bytes: number }, LogStoreError> =>
  Effect.gen(function* () {
    const entries = [...document.entries];
    let bytes = initialBytes ?? (yield* encodedSize(entries, path));
    while (entries.length > maxEntries || bytes > maxBytes) {
      if (entries.length === 0) break;
      const removed = entries.shift();
      if (removed !== undefined) {
        const encoded = yield* encodedEntry(removed, path);
        bytes -= new TextEncoder().encode(`${encoded}\n`).byteLength;
      }
    }
    return { document: { ...document, entries }, bytes };
  });

const persist = (
  fs: FileSystem.FileSystem,
  path: string,
  entries: ReadonlyArray<StackLogEntry>,
): Effect.Effect<void, LogStoreError> => {
  const temporary = `${path}.tmp`;
  const write = Effect.gen(function* () {
    const lines = yield* Effect.forEach(entries, (entry) => encodedEntry(entry, path));
    const text = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(temporary, { flag: "w", mode: 0o600 });
        if (text.length > 0) yield* file.writeAll(new TextEncoder().encode(text));
      }),
    );
    yield* fs.chmod(temporary, 0o600);
    yield* fs.remove(`${path}.1`, { force: true });
    if (yield* fs.exists(path)) yield* fs.rename(path, `${path}.1`);
    yield* fs.rename(temporary, path);
    yield* fs.chmod(path, 0o600);
  });
  return write.pipe(
    Effect.ensuring(
      fs
        .remove(temporary, { force: true })
        .pipe(Effect.catchTag("PlatformError", () => Effect.void)),
    ),
    Effect.mapError((error) =>
      error instanceof LogStoreError
        ? error
        : fileError(path, "Unable to persist retained logs", error),
    ),
  );
};

const validLimit = (value: number | undefined, fallback: number): number =>
  value === undefined || (Number.isFinite(value) && value >= 1) ? Math.floor(value ?? fallback) : 0;

export const makeLogStore = (
  options: LogStoreOptions,
): Effect.Effect<LogStore, LogStoreError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const maxEntries = validLimit(options.maxEntries, 1_000);
    const maxBytes = validLimit(options.maxBytes, 1024 * 1024);
    if (maxEntries < 1 || maxBytes < 1)
      return yield* fileError(options.path, "Log retention limits must be positive");

    yield* fs
      .makeDirectory(pathService.dirname(options.path), { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError((error) =>
          fileError(options.path, "Unable to create log directory", error),
        ),
      );
    const parentDirectory = pathService.dirname(options.path);
    yield* fs
      .chmod(parentDirectory, 0o700)
      .pipe(
        Effect.mapError((error) =>
          fileError(options.path, "Unable to secure retained log directory", error),
        ),
      );
    if (maxBytes < 2)
      return yield* fileError(options.path, "Log byte retention limit is too small");
    const knownSecrets = options.knownSecrets ?? [];
    const loaded = yield* readDocument(fs, options.path);
    const redactedLoaded = redactDocument(loaded, knownSecrets);
    const boundedLoaded = yield* bounded(
      redactedLoaded.document,
      maxEntries,
      maxBytes,
      options.path,
    );
    let document = boundedLoaded.document;
    let retainedBytes = boundedLoaded.bytes;
    const exists = yield* fs
      .exists(options.path)
      .pipe(
        Effect.mapError((error) =>
          fileError(options.path, "Unable to inspect retained logs", error),
        ),
      );
    if (exists)
      yield* fs
        .chmod(options.path, 0o600)
        .pipe(
          Effect.mapError((error) =>
            fileError(options.path, "Unable to secure retained logs", error),
          ),
        );
    if (redactedLoaded.changed || boundedLoaded.document.entries.length !== loaded.entries.length)
      yield* persist(fs, options.path, boundedLoaded.document.entries);
    const semaphore = yield* Semaphore.make(1);
    const pubsub = yield* PubSub.unbounded<StackLogEntry>();

    const append = (record: LogRecord) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const cursor = opaqueCursor(document.nextCursor);
          const entry = {
            cursor,
            timestamp: record.timestamp ?? DateTime.formatIso(DateTime.nowUnsafe()),
            source: record.source,
            stream: record.stream,
            message: redactKnownSecrets(record.message, knownSecrets),
          } satisfies StackLogEntry;
          const next = {
            nextCursor: document.nextCursor + 1,
            entries: [...document.entries, entry],
          };
          const encoded = yield* encodedEntry(entry, options.path);
          const entryBytes = new TextEncoder().encode(`${encoded}\n`).byteLength;
          const nextBytes = retainedBytes + entryBytes;
          if (document.entries.length + 1 <= maxEntries && nextBytes <= maxBytes) {
            document = next;
            retainedBytes = nextBytes;
            yield* Effect.scoped(
              Effect.gen(function* () {
                const file = yield* fs.open(options.path, { flag: "a", mode: 0o600 });
                yield* file.writeAll(new TextEncoder().encode(`${encoded}\n`));
              }),
            ).pipe(
              Effect.mapError((error) =>
                error instanceof LogStoreError
                  ? error
                  : fileError(options.path, "Unable to append retained logs", error),
              ),
            );
          } else {
            const boundedNext = yield* bounded(next, maxEntries, maxBytes, options.path, nextBytes);
            document = boundedNext.document;
            retainedBytes = boundedNext.bytes;
            yield* persist(fs, options.path, document.entries);
          }
          yield* PubSub.publish(pubsub, entry);
          return entry;
        }),
      );

    const read = (readOptions?: LogOptions) =>
      semaphore.withPermit(selected(document.entries, readOptions, options.path));

    const stream = (streamOptions?: LogOptions): Stream.Stream<StackLogEntry, LogStoreError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const handoff = yield* semaphore.withPermit(
            Effect.gen(function* () {
              const retainedEntries = yield* selected(
                document.entries,
                streamOptions,
                options.path,
              );
              const requestedCursor = yield* decodeCursor(options.path, streamOptions?.cursor);
              const lastRetainedCursor = document.entries.at(-1)?.cursor.opaque;
              const retainedCursor =
                lastRetainedCursor === undefined
                  ? undefined
                  : yield* parseOpaqueCursor(options.path, lastRetainedCursor);
              const handoffCursor =
                retainedCursor === undefined
                  ? requestedCursor
                  : requestedCursor === undefined
                    ? retainedCursor
                    : Math.max(retainedCursor, requestedCursor);
              if (streamOptions?.follow !== true)
                return { retainedEntries, handoffCursor, subscription: undefined } as const;
              const subscription = yield* PubSub.subscribe(pubsub);
              return { retainedEntries, handoffCursor, subscription } as const;
            }),
          );
          const retainedStream = Stream.fromIterable(handoff.retainedEntries);
          if (handoff.subscription === undefined) return retainedStream;
          const capabilities =
            streamOptions?.capabilities === undefined
              ? undefined
              : new Set(streamOptions.capabilities);
          const liveStream = Stream.fromEffectRepeat(PubSub.take(handoff.subscription)).pipe(
            Stream.filter((entry) => {
              if (
                handoff.handoffCursor !== undefined &&
                Number.parseInt(entry.cursor.opaque.slice(CURSOR_PREFIX.length), 36) <=
                  handoff.handoffCursor
              )
                return false;
              if (capabilities === undefined) return true;
              return (
                entry.source !== "gateway" &&
                entry.source !== "supervisor" &&
                capabilities.has(entry.source)
              );
            }),
          );
          return Stream.concat(retainedStream, liveStream);
        }),
      ).pipe(Stream.scoped);

    return {
      path: options.path,
      append,
      read,
      stream,
    };
  });
