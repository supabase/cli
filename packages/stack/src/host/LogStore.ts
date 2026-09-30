import {
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  PubSub,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { failureMessage } from "../internal/failure-message.ts";
import { errorCode, retrySharingViolation } from "../internal/sharing-violation.ts";
import type { LaunchOutput } from "../runtime/Session.ts";
import type { CatalogLogs } from "../services/Recipe.ts";
import {
  encodeEntry,
  makeSplitter,
  parseRecord,
  segmentGeneration,
  segmentName,
  type LogEntry,
  type LogPosition,
  type LogRecord,
  type StackLogRecord,
} from "./LogRecord.ts";

/** A log store operation that failed. */
export class LogStoreError extends Schema.TaggedError<LogStoreError>()("LogStoreError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const storeError = (operation: string) => (cause: unknown) =>
  new LogStoreError({ operation, message: failureMessage(cause), cause });

const removeError = (directory: string) => (cause: unknown) =>
  new LogStoreError({
    operation: "remove",
    message: `Unable to remove ${directory}: ${failureMessage(cause)}`,
    cause,
  });

export interface LogStoreOptions {
  /** The stack's logs directory. */
  readonly root: string;
  /** A segment reaching this size is closed and a new generation is opened. */
  readonly rotateBytes?: number;
  /** Oldest closed segments are deleted while an instance's segments exceed this size. */
  readonly retainBytes?: number;
  /** Oldest closed segments are deleted while an instance has more segments than this. */
  readonly retainSegments?: number;
  readonly platform?: NodeJS.Platform;
}

/** Selects the records a read returns. */
export interface ReadOptions {
  /** `end` skips every record written before the read starts; a position resumes there. */
  readonly from: "oldest" | "end" | LogPosition;
  /** Epoch milliseconds; older records are skipped. */
  readonly since?: number;
  /** Returns only the last records of the history before following; requires `from: "oldest"`. */
  readonly tail?: number;
  readonly follow: boolean;
}

/** An instance whose output the store persists. */
export interface AttachedInstance {
  readonly service: string;
  readonly instanceId: string;
  readonly logs: CatalogLogs;
  readonly observation: Stream.Stream<{ readonly launchId: number | undefined }>;
}

export interface Interface {
  /** Subscribes to the instance's output before returning; persistence failures never fail it. */
  readonly attach: (instance: AttachedInstance) => Effect.Effect<void>;
  /** Fixes the read's start and wake subscription in the scope; the stream reads lazily. */
  readonly read: (
    instanceId: string,
    options: ReadOptions,
  ) => Effect.Effect<Stream.Stream<LogRecord, LogStoreError>, LogStoreError, Scope.Scope>;
  /** The directory holding an attached instance's segments and its forwarding cursor. */
  readonly directory: (instanceId: string) => Effect.Effect<string, LogStoreError>;
  /** Stops the instance's writer and readers, then deletes its segments. */
  readonly remove: (instance: {
    readonly service: string;
    readonly instanceId: string;
  }) => Effect.Effect<void, LogStoreError>;
  /** Deletes log directories of instances that are not attached; failures are logged. */
  readonly removeOrphans: Effect.Effect<void, LogStoreError>;
  /** Stops every writer and reader; later reads fail. */
  readonly close: Effect.Effect<void>;
}

const defaultRotateBytes = 5 * 1024 * 1024;
const defaultRetainBytes = 10 * 1024 * 1024;
const defaultRetainSegments = 64;
/** Bounds how much of a segment one read step holds in memory; above the longest record. */
const readChunkBytes = 256 * 1024;
/** Concurrent read steps per instance; removal takes them all to wait out in-flight reads. */
const readerPermits = 1024;
const retryBaseMillis = 100;
const retryMaxMillis = 30_000;
const drainBatch = 4096;
const drainTimeout = Duration.seconds(5);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Live {
  readonly lock: Semaphore.Semaphore;
  readonly end: Ref.Ref<LogPosition>;
  readonly wake: PubSub.PubSub<void>;
  readonly passes: Semaphore.Semaphore;
}

interface Step {
  readonly records: ReadonlyArray<LogRecord>;
  readonly cursor: LogPosition;
  /** The segment listing to reuse; `undefined` asks the next step to list again. */
  readonly listed: ReadonlyArray<number> | undefined;
  /** The cursor reached the last complete record of the newest segment. */
  readonly atEnd: boolean;
  /** Bytes after the cursor did not yet form a complete record. */
  readonly partial: boolean;
}

interface Chunk {
  readonly records: ReadonlyArray<LogRecord>;
  readonly byteOffset: number;
  /** The read consumed bytes; otherwise it met the end of the segment. */
  readonly progressed: boolean;
  readonly partial: boolean;
}

const before = (cursor: LogPosition, end: LogPosition) =>
  cursor.generation < end.generation ||
  (cursor.generation === end.generation && cursor.byteOffset < end.byteOffset);

/** Parses an ISO-8601 `since` bound into epoch milliseconds. */
export const sinceMillis = (since: string): Effect.Effect<number, LogStoreError> =>
  Option.match(DateTime.make(since), {
    onNone: () =>
      Effect.fail(
        new LogStoreError({ operation: "read", message: `Invalid since timestamp ${since}` }),
      ),
    onSome: (time) => Effect.succeed(DateTime.toEpochMillis(time)),
  });

const isNotFound = (error: { readonly reason: { readonly _tag: string } }) =>
  error.reason._tag === "NotFound";

/** A missing directory, or a file where a directory was expected, holds no segments. */
const isMissingDirectory = (error: { readonly reason: { readonly _tag: string } }) =>
  isNotFound(error) || errorCode(error) === "ENOTDIR";

interface FollowState {
  readonly cursor: LogPosition;
  readonly listed: ReadonlyArray<number> | undefined;
}

const page = (
  records: ReadonlyArray<LogRecord>,
  next: Option.Option<FollowState>,
): readonly [ReadonlyArray<LogRecord>, Option.Option<FollowState>] => [records, next];

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const recordPosition = (record: LogRecord) =>
  record.position ?? record.resumeAt ?? { generation: 0, byteOffset: 0 };

/** Orders an instance's records by timestamp and position; a gap marker precedes its resume. */
const compareRecords = (left: LogRecord, right: LogRecord) => {
  const leftPosition = recordPosition(left);
  const rightPosition = recordPosition(right);
  return (
    compareText(left.timestamp, right.timestamp) ||
    leftPosition.generation - rightPosition.generation ||
    leftPosition.byteOffset - rightPosition.byteOffset ||
    Number(left.position !== undefined) - Number(right.position !== undefined)
  );
};

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
);

/** Lists the subdirectories of `directory`; files and a missing directory list nothing. */
const listDirectories = (fs: FileSystem.FileSystem, path: Path.Path, directory: string) =>
  fs.readDirectory(directory).pipe(
    Effect.catchIf(isMissingDirectory, () => Effect.succeed<ReadonlyArray<string>>([])),
    Effect.flatMap((names) =>
      Effect.filter(names, (name) =>
        fs.stat(path.join(directory, name)).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.catchIf(isNotFound, () => Effect.succeed(false)),
        ),
      ),
    ),
    Effect.mapError(storeError("list")),
  );

const makeReader = (fs: FileSystem.FileSystem, path: Path.Path) => {
  const generations = (directory: string) =>
    fs.readDirectory(directory).pipe(
      Effect.map((names) =>
        names
          .map(segmentGeneration)
          .filter((generation) => generation !== undefined)
          .toSorted((left, right) => left - right),
      ),
      Effect.catchIf(isMissingDirectory, () => Effect.succeed<ReadonlyArray<number>>([])),
      Effect.mapError(storeError("list")),
    );

  const segments = (directory: string) =>
    generations(directory).pipe(
      Effect.flatMap((listed) =>
        Effect.forEach(listed, (generation) =>
          fs.stat(path.join(directory, segmentName(generation))).pipe(
            Effect.map((info) => [{ generation, size: Number(info.size) }]),
            Effect.catchIf(isNotFound, () =>
              Effect.succeed<ReadonlyArray<{ generation: number; size: number }>>([]),
            ),
            Effect.mapError(storeError("list")),
          ),
        ),
      ),
      Effect.map((listed) => listed.flat()),
    );

  const readChunk = (file: string, offset: number) =>
    Effect.scoped(
      fs.open(file, { flag: "r" }).pipe(
        Effect.tap((handle) => handle.seek(offset, "start")),
        Effect.flatMap((handle) => handle.readAlloc(readChunkBytes)),
        Effect.map(Option.getOrElse(() => new Uint8Array(0))),
        Effect.map(Option.some),
      ),
    ).pipe(
      Effect.catchIf(isNotFound, () => Effect.succeed(Option.none<Uint8Array>())),
      Effect.mapError(storeError("read")),
    );

  const guarded = <A, E>(live: Live | undefined, effect: Effect.Effect<A, E>) =>
    live === undefined ? effect : live.passes.withPermits(1)(effect);

  /** Reads the complete records of one chunk at `position`; `none` when the segment is gone. */
  const readAt = (directory: string, position: LogPosition, live: Live | undefined) =>
    guarded(
      live,
      readChunk(path.join(directory, segmentName(position.generation)), position.byteOffset),
    ).pipe(
      Effect.map(
        Option.map((bytes): Chunk => {
          const last = bytes.lastIndexOf(0x0a);
          if (last < 0)
            return bytes.length === readChunkBytes
              ? {
                  records: [],
                  byteOffset: position.byteOffset + bytes.length,
                  progressed: true,
                  partial: false,
                }
              : {
                  records: [],
                  byteOffset: position.byteOffset,
                  progressed: false,
                  partial: bytes.length > 0,
                };
          const records: Array<LogRecord> = [];
          let start = 0;
          while (start <= last) {
            const stop = bytes.indexOf(0x0a, start);
            const record = parseRecord(decoder.decode(bytes.subarray(start, stop)), {
              generation: position.generation,
              byteOffset: position.byteOffset + start,
            });
            if (record !== undefined) records.push(record);
            start = stop + 1;
          }
          return {
            records,
            byteOffset: position.byteOffset + last + 1,
            progressed: true,
            partial: false,
          };
        }),
      ),
    );

  /**
   * Advances `cursor` by at most one chunk. The segment listing is reused until the cursor reaches
   * the end of the listed segments or a listed segment disappears.
   */
  const step = Effect.fnUntraced(function* (
    directory: string,
    cursor: LogPosition,
    cached: ReadonlyArray<number> | undefined,
    live: Live | undefined,
  ) {
    const fresh = cached === undefined;
    const listed = cached ?? (yield* generations(directory));
    const relist = (partial: boolean): Step => ({
      records: [],
      cursor,
      listed: undefined,
      atEnd: false,
      partial,
    });
    const atEnd = (partial: boolean): Step => ({
      records: [],
      cursor,
      listed,
      atEnd: true,
      partial,
    });
    const first = listed[0];
    if (first === undefined) return fresh ? atEnd(false) : relist(false);
    if (cursor.generation < first) {
      const resumeAt = { generation: first, byteOffset: 0 };
      const records: ReadonlyArray<LogRecord> =
        cursor.generation === 0 ? [] : [{ kind: "lost", timestamp: yield* nowIso, resumeAt }];
      return { records, cursor: resumeAt, listed, atEnd: false, partial: false } satisfies Step;
    }
    const newer = listed.find((generation) => generation > cursor.generation);
    const moveOn = (generation: number): Step => ({
      records: [],
      cursor: { generation, byteOffset: 0 },
      listed,
      atEnd: false,
      partial: false,
    });
    if (!listed.includes(cursor.generation))
      return newer !== undefined ? moveOn(newer) : fresh ? atEnd(false) : relist(false);
    const chunk = yield* readAt(directory, cursor, live);
    if (Option.isNone(chunk)) return relist(false);
    if (chunk.value.progressed)
      return {
        records: chunk.value.records,
        cursor: { ...cursor, byteOffset: chunk.value.byteOffset },
        listed,
        atEnd: false,
        partial: false,
      } satisfies Step;
    // A segment is closed once a newer one exists, so its incomplete tail never completes.
    if (newer !== undefined) return moveOn(newer);
    if (fresh) return atEnd(chunk.value.partial);
    const writing = live === undefined ? undefined : yield* Ref.get(live.end);
    return writing !== undefined && writing.generation <= cursor.generation
      ? atEnd(chunk.value.partial)
      : relist(chunk.value.partial);
  });

  const since = (options: Pick<ReadOptions, "since">) => (record: LogRecord) =>
    options.since === undefined || Date.parse(record.timestamp) >= options.since;

  /** Reads one segment from its start; a segment deleted meanwhile yields what was read. */
  const readSegment = Effect.fnUntraced(function* (
    directory: string,
    generation: number,
    live: Live | undefined,
  ) {
    const records: Array<LogRecord> = [];
    let position: LogPosition = { generation, byteOffset: 0 };
    while (true) {
      const chunk = yield* readAt(directory, position, live);
      if (Option.isNone(chunk) || !chunk.value.progressed) break;
      records.push(...chunk.value.records);
      position = { generation, byteOffset: chunk.value.byteOffset };
    }
    return { records, position };
  });

  /**
   * Reads the history after `cursor`. With `tail`, only the newest segments that hold the last
   * `tail` records are read.
   */
  const history = Effect.fnUntraced(function* (
    directory: string,
    cursor: LogPosition,
    options: Pick<ReadOptions, "since" | "tail">,
    live: Live | undefined,
  ) {
    const keep = since(options);
    const listed = yield* generations(directory);
    const tail = options.tail;
    if (tail !== undefined) {
      if (tail === 0)
        return {
          records: [],
          cursor: live === undefined ? cursor : yield* live.lock.withPermits(1)(Ref.get(live.end)),
          listed,
        };
      // A partial line is written when it ends, so a segment can hold a record older than records
      // in the segment before it; one more segment is read past each stopping point.
      const collected: Array<LogRecord> = [];
      let end: LogPosition = cursor;
      let first = true;
      let past = 0;
      for (const generation of listed.toReversed()) {
        const segment = yield* readSegment(directory, generation, live);
        if (first) end = segment.position;
        first = false;
        const matching = segment.records.filter(keep);
        collected.push(...matching);
        const olderThanSince =
          options.since !== undefined && segment.records.length > 0 && matching.length === 0;
        past = collected.length >= tail || olderThanSince ? past + 1 : 0;
        if (past > 1) break;
      }
      const records = collected.toSorted(compareRecords);
      return { records: records.slice(Math.max(0, records.length - tail)), cursor: end, listed };
    }
    const records: Array<LogRecord> = [];
    let current = cursor;
    let cached: ReadonlyArray<number> | undefined = listed;
    while (true) {
      const next: Step = yield* step(directory, current, cached, live);
      for (const record of next.records) if (keep(record)) records.push(record);
      current = next.cursor;
      cached = next.listed;
      if (next.atEnd) break;
    }
    return { records, cursor: current, listed: cached };
  });

  /** Streams records from `cursor`; a follower waits on the wake signal it subscribed to first. */
  const follow = (
    directory: string,
    start: { readonly cursor: LogPosition; readonly listed: ReadonlyArray<number> | undefined },
    options: Pick<ReadOptions, "since" | "follow">,
    live: Live | undefined,
    wake: PubSub.Subscription<void> | undefined,
  ): Stream.Stream<LogRecord, LogStoreError> =>
    Stream.paginate(start, (current) =>
      Effect.gen(function* () {
        const next: Step = yield* step(directory, current.cursor, current.listed, live);
        const resume = Option.some({ cursor: next.cursor, listed: next.listed });
        if (!next.atEnd) return page(next.records, resume);
        if (!options.follow || live === undefined || wake === undefined)
          return page(next.records, Option.none());
        const end = yield* live.lock.withPermits(1)(Ref.get(live.end));
        if (!next.partial && before(next.cursor, end)) return page(next.records, resume);
        yield* PubSub.take(wake);
        return page(next.records, resume);
      }),
    ).pipe(Stream.filter(since(options)));

  /** Subscribes and fixes the start position now; the returned stream reads lazily. */
  const read = Effect.fnUntraced(function* (
    directory: string,
    options: ReadOptions,
    live: Live | undefined,
  ) {
    if (options.tail !== undefined && options.from !== "oldest")
      return yield* new LogStoreError({
        operation: "read",
        message: "A tailed read starts at the oldest record and cannot also set a start position",
      });
    const wake =
      options.follow && live !== undefined ? yield* PubSub.subscribe(live.wake) : undefined;
    const start =
      options.from === "oldest"
        ? { generation: 0, byteOffset: 0 }
        : options.from === "end"
          ? live === undefined
            ? { generation: 0, byteOffset: 0 }
            : yield* live.lock.withPermits(1)(Ref.get(live.end))
          : options.from;
    if (options.tail === undefined)
      return follow(directory, { cursor: start, listed: undefined }, options, live, wake);
    return Stream.unwrap(
      history(directory, start, options, live).pipe(
        Effect.map((past) =>
          Stream.fromIterable(past.records).pipe(
            Stream.concat(
              options.follow
                ? follow(
                    directory,
                    { cursor: past.cursor, listed: past.listed },
                    options,
                    live,
                    wake,
                  )
                : Stream.empty,
            ),
          ),
        ),
      ),
    );
  });

  /** Streams a directory's records in file order without an owner. */
  const records = (directory: string, options: Pick<ReadOptions, "since">) =>
    follow(
      directory,
      { cursor: { generation: 0, byteOffset: 0 }, listed: undefined },
      { ...options, follow: false },
      undefined,
      undefined,
    );

  return { read, history, records, segments, generations };
};

/** Creates the owner's log store; closing its scope flushes and closes every writer. */
export const make = Effect.fn("LogStore.make")(function* (options: LogStoreOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storeScope = yield* Scope.Scope;
  const reader = makeReader(fs, path);
  const rotateBytes = options.rotateBytes ?? defaultRotateBytes;
  const retainBytes = options.retainBytes ?? defaultRetainBytes;
  const retainSegments = options.retainSegments ?? defaultRetainSegments;
  const retryShared = retrySharingViolation(options.platform);

  interface Attached extends Live {
    readonly service: string;
    readonly instanceId: string;
    readonly directory: string;
    readonly closed: Deferred.Deferred<void>;
    readonly scope: Scope.Closeable;
  }
  const instances = yield* Ref.make<ReadonlyMap<string, Attached>>(new Map());
  const closed = yield* Ref.make(false);
  const attached = (instanceId: string) =>
    Ref.get(instances).pipe(
      Effect.flatMap((current) => {
        const instance = current.get(instanceId);
        return instance === undefined
          ? Effect.fail(
              new LogStoreError({
                operation: "read",
                message: `Instance ${instanceId} has no logs`,
              }),
            )
          : Effect.succeed(instance);
      }),
    );

  const detach = Effect.fnUntraced(function* (instance: Attached) {
    yield* Deferred.succeed(instance.closed, undefined);
    yield* instance.passes.take(readerPermits);
    yield* Scope.close(instance.scope, Exit.void);
  });

  const attach = Effect.fn("LogStore.attach")(function* (instance: AttachedInstance) {
    if (yield* Ref.get(closed)) return;
    const directory = path.join(options.root, instance.service, instance.instanceId);
    // An unreadable listing defers choosing the next generation to the first append.
    const existing = yield* reader.segments(directory).pipe(
      retryShared,
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.logWarning(`Unable to list logs in ${directory}`, error).pipe(
          Effect.as(Option.none<ReadonlyArray<{ generation: number; size: number }>>()),
        ),
      ),
    );
    const latest = Option.getOrElse(existing, () => []).at(-1);
    const scope = yield* Scope.fork(storeScope, "sequential");
    const handle: Attached = {
      service: instance.service,
      instanceId: instance.instanceId,
      directory,
      scope,
      lock: yield* Semaphore.make(1),
      passes: yield* Semaphore.make(readerPermits),
      end: yield* Ref.make<LogPosition>({
        generation: latest?.generation ?? 0,
        byteOffset: latest?.size ?? 0,
      }),
      wake: yield* PubSub.sliding<void>(1),
      closed: yield* Deferred.make<void>(),
    };
    const splitter = makeSplitter();
    let nextGeneration: number | undefined = Option.isSome(existing)
      ? (latest?.generation ?? 0) + 1
      : undefined;
    let file:
      | {
          readonly handle: FileSystem.File;
          readonly scope: Scope.Closeable;
          readonly generation: number;
          size: number;
        }
      | undefined;
    /** Chunks not persisted, reported as `lost` by the next successful append. */
    const dropped = new Map<string, Extract<LogEntry, { kind: "lost" }>>();
    let broken: { readonly attempts: number; readonly retryAt: number } | undefined;

    const closeFile = Effect.suspend(() => {
      const current = file;
      file = undefined;
      return current === undefined ? Effect.void : Scope.close(current.scope, Exit.void);
    });

    const enforceRetention = reader.segments(directory).pipe(
      Effect.flatMap((listed) =>
        Effect.gen(function* () {
          let total = listed.reduce((sum, segment) => sum + segment.size, 0);
          let count = listed.length;
          // The newest closed segment holds the latest records before the open one.
          const newestClosed = listed
            .map(({ generation }) => generation)
            .filter((generation) => generation !== file?.generation)
            .at(-1);
          for (const segment of listed) {
            if (total <= retainBytes && count <= retainSegments) return;
            if (segment.generation === file?.generation || segment.generation === newestClosed)
              return;
            // A reader holding the file on Windows defers its deletion to the next rotation.
            const removed = yield* fs
              .remove(path.join(directory, segmentName(segment.generation)), { force: true })
              .pipe(
                retryShared,
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
            if (!removed) continue;
            total -= segment.size;
            count -= 1;
          }
        }),
      ),
      Effect.ignore,
    );

    const openGeneration = Effect.gen(function* () {
      yield* closeFile;
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const generation =
        nextGeneration ??
        ((yield* reader.generations(directory).pipe(retryShared)).at(-1) ?? 0) + 1;
      nextGeneration = generation + 1;
      const fileScope = yield* Scope.make("sequential");
      const opened = yield* fs
        .open(path.join(directory, segmentName(generation)), { flag: "ax", mode: 0o600 })
        .pipe(
          Scope.provide(fileScope),
          Effect.onError(() =>
            Scope.close(fileScope, Exit.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  nextGeneration = undefined;
                }),
              ),
            ),
          ),
        );
      file = { handle: opened, scope: fileScope, generation, size: 0 };
      yield* Ref.set(handle.end, { generation, byteOffset: 0 });
      yield* PubSub.publish(handle.wake, undefined);
      yield* enforceRetention;
      return file;
    }).pipe(Effect.mapError(storeError("open")));

    const writePieces = (pieces: ReadonlyArray<Uint8Array>) =>
      Effect.gen(function* () {
        const current = file ?? (yield* openGeneration);
        const bytes = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
        let offset = 0;
        for (const piece of pieces) {
          bytes.set(piece, offset);
          offset += piece.length;
        }
        yield* current.handle.writeAll(bytes).pipe(
          Effect.mapError(storeError("write")),
          Effect.tapError(() => closeFile),
        );
        current.size += bytes.length;
        yield* Ref.set(handle.end, { generation: current.generation, byteOffset: current.size });
        yield* PubSub.publish(handle.wake, undefined);
      });

    /** Appends records, rotating before a record that would overflow the segment. */
    const append = (entries: ReadonlyArray<LogEntry>) =>
      Effect.gen(function* () {
        let pieces: Array<Uint8Array> = [];
        let pending = 0;
        for (const entry of entries) {
          const bytes = encoder.encode(encodeEntry(entry));
          const used = (file?.size ?? 0) + pending;
          if (used > 0 && used + bytes.length > rotateBytes) {
            if (pieces.length > 0) yield* writePieces(pieces);
            yield* openGeneration;
            pieces = [];
            pending = 0;
          }
          pieces.push(bytes);
          pending += bytes.length;
        }
        if (pieces.length > 0) yield* writePieces(pieces);
      });

    const countDropped = (chunks: ReadonlyArray<LaunchOutput>) => {
      for (const chunk of chunks) {
        const key = `${chunk.launchId}:${chunk.stream}`;
        dropped.set(key, {
          kind: "lost",
          timestamp: chunk.time,
          launchId: chunk.launchId,
          stream: chunk.stream,
          count: (dropped.get(key)?.count ?? 0) + 1,
        });
      }
    };

    /**
     * Appends records. After a failure, appends are skipped with backoff and their chunks are
     * reported as `lost` once writing works again.
     */
    const persist = Effect.fnUntraced(function* (
      entries: ReadonlyArray<LogEntry>,
      chunks: ReadonlyArray<LaunchOutput>,
    ) {
      const now = yield* Clock.currentTimeMillis;
      if (broken !== undefined && now < broken.retryAt) return countDropped(chunks);
      if (entries.length === 0 && dropped.size === 0) return;
      const written = yield* append([...dropped.values(), ...entries]).pipe(Effect.exit);
      if (Exit.isSuccess(written)) {
        dropped.clear();
        broken = undefined;
        return;
      }
      countDropped(chunks);
      if (broken === undefined)
        yield* Effect.logError(
          `Unable to persist ${instance.service} logs of instance ${instance.instanceId}; retrying with a new segment`,
          written.cause,
        );
      const attempts = (broken?.attempts ?? 0) + 1;
      broken = {
        attempts,
        retryAt: now + Math.min(retryBaseMillis * 2 ** (attempts - 1), retryMaxMillis),
      };
    });

    const persistBatch = (chunks: ReadonlyArray<LaunchOutput>) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          handle.lock.withPermits(1)(
            Effect.suspend(() =>
              persist(
                [...chunks.flatMap((chunk) => splitter.push(chunk)), ...splitter.flushEnded(now)],
                chunks,
              ),
            ),
          ),
        ),
        Effect.uninterruptible,
      );

    const flushLaunches = Effect.gen(function* () {
      const previous = yield* Ref.make<number | undefined>(undefined);
      yield* instance.observation.pipe(
        Stream.map(({ launchId }) => launchId),
        Stream.changes,
        Stream.runForEach((launchId) =>
          Ref.getAndSet(previous, launchId).pipe(
            Effect.flatMap((prior) =>
              prior === undefined
                ? Effect.void
                : Clock.currentTimeMillis.pipe(
                    Effect.flatMap((now) =>
                      handle.lock.withPermits(1)(
                        Effect.suspend(() => persist(splitter.endLaunch(prior, now), [])),
                      ),
                    ),
                  ),
            ),
          ),
        ),
      );
    });

    const subscription = yield* instance.logs.pipe(Scope.provide(scope));
    /** Writes output still queued at close, within a bound; the rest is recorded as lost. */
    const drain = Effect.gen(function* () {
      while (true) {
        const chunks = yield* PubSub.takeUpTo(subscription, drainBatch);
        if (chunks.length === 0) return;
        yield* persistBatch(chunks);
      }
    }).pipe(
      Effect.timeoutOption(drainTimeout),
      Effect.flatMap(
        Option.match({
          onSome: () => Effect.void,
          onNone: () =>
            PubSub.takeUpTo(subscription, Number.MAX_SAFE_INTEGER).pipe(
              Effect.flatMap((chunks) =>
                handle.lock.withPermits(1)(
                  Effect.suspend(() => {
                    countDropped(chunks);
                    broken = undefined;
                    return persist([], []);
                  }),
                ),
              ),
            ),
        }),
      ),
    );
    yield* Scope.addFinalizer(
      scope,
      drain.pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.flatMap((now) =>
          handle.lock.withPermits(1)(Effect.suspend(() => persist(splitter.flush(now), []))),
        ),
        Effect.ignore,
        Effect.andThen(closeFile),
      ),
    );
    // A taken batch is always persisted, so interruption only lands while waiting for output.
    yield* Effect.forkIn(
      Effect.forever(
        Effect.uninterruptibleMask((restore) =>
          restore(PubSub.takeAll(subscription)).pipe(Effect.flatMap(persistBatch)),
        ),
      ),
      scope,
    );
    yield* Effect.forkIn(flushLaunches, scope);
    yield* Ref.update(instances, (current) => new Map(current).set(instance.instanceId, handle));
  });

  const read = Effect.fn("LogStore.read")(function* (instanceId: string, readOptions: ReadOptions) {
    const instance = yield* attached(instanceId);
    const records = yield* reader.read(instance.directory, readOptions, instance);
    return records.pipe(Stream.interruptWhen(Deferred.await(instance.closed)));
  });

  const remove = Effect.fn("LogStore.remove")(function* (target: {
    readonly service: string;
    readonly instanceId: string;
  }) {
    const directory = path.join(options.root, target.service, target.instanceId);
    const instance = (yield* Ref.get(instances)).get(target.instanceId);
    if (instance !== undefined) {
      yield* Ref.update(instances, (current) => {
        const next = new Map(current);
        next.delete(target.instanceId);
        return next;
      });
      yield* detach(instance);
    }
    yield* fs
      .remove(directory, { recursive: true, force: true })
      .pipe(retryShared, Effect.mapError(removeError(directory)));
  });

  /** Deletes log directories whose instance is no longer attached, left by a failed removal. */
  const removeOrphans = Effect.fn("LogStore.removeOrphans")(function* () {
    const current = yield* Ref.get(instances);
    for (const service of yield* listDirectories(fs, path, options.root))
      for (const instanceId of yield* listDirectories(fs, path, path.join(options.root, service)))
        if (!current.has(instanceId)) {
          const directory = path.join(options.root, service, instanceId);
          yield* fs.remove(directory, { recursive: true, force: true }).pipe(
            retryShared,
            Effect.catch((error) =>
              Effect.logWarning(`Unable to remove orphaned logs ${directory}`, error),
            ),
          );
        }
  });

  const close = Effect.gen(function* () {
    yield* Ref.set(closed, true);
    const current = yield* Ref.getAndSet(instances, new Map());
    yield* Effect.forEach(current.values(), detach, { discard: true });
  }).pipe(Effect.withSpan("LogStore.close"));

  yield* Effect.addFinalizer(() => close);

  return {
    attach,
    read,
    directory: (instanceId) => Effect.map(attached(instanceId), (instance) => instance.directory),
    remove,
    removeOrphans: removeOrphans(),
    close,
  } satisfies Interface;
});

/** Lists the instance directories of a stack's logs, limited to `instances` when given. */
const persistedInstances = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  instances: ReadonlyArray<string> | undefined,
) {
  const selected: Array<{ readonly service: string; readonly instanceId: string }> = [];
  for (const service of yield* listDirectories(fs, path, root))
    for (const instanceId of yield* listDirectories(fs, path, path.join(root, service)))
      if (instances === undefined || instances.includes(instanceId))
        selected.push({ service, instanceId });
  return selected;
});

/** Streams persisted records of a stack's instances, one instance after another in file order. */
export const streamStackLogs = (options: {
  readonly root: string;
  readonly instances?: ReadonlyArray<string>;
  readonly since?: number;
}): Stream.Stream<StackLogRecord, LogStoreError, FileSystem.FileSystem | Path.Path> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reader = makeReader(fs, path);
      const selected = yield* persistedInstances(fs, path, options.root, options.instances);
      return Stream.fromIterable(selected).pipe(
        Stream.flatMap(({ service, instanceId }) =>
          reader
            .records(path.join(options.root, service, instanceId), options)
            .pipe(Stream.map((record): StackLogRecord => ({ ...record, service, instanceId }))),
        ),
      );
    }),
  );

/** Reads persisted records of a stack's instances, merged by time, service, instance and position. */
export const readStackLogs = Effect.fn("LogStore.readStackLogs")(function* (options: {
  readonly root: string;
  readonly instances?: ReadonlyArray<string>;
  readonly since?: number;
  readonly tail?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const reader = makeReader(fs, path);
  const selected = yield* persistedInstances(fs, path, options.root, options.instances);
  const perInstance = yield* Effect.forEach(
    selected,
    ({ service, instanceId }) =>
      reader
        .history(
          path.join(options.root, service, instanceId),
          { generation: 0, byteOffset: 0 },
          options,
          undefined,
        )
        .pipe(
          Effect.map(({ records }) =>
            records.map((record): StackLogRecord => ({ ...record, service, instanceId })),
          ),
        ),
    { concurrency: 4 },
  );
  const merged = perInstance.flat().toSorted(compareStackRecords);
  return options.tail === undefined
    ? merged
    : merged.slice(Math.max(0, merged.length - options.tail));
});

/** Orders records by timestamp, service, instance and position. */
const compareStackRecords = (left: StackLogRecord, right: StackLogRecord) =>
  compareText(left.timestamp, right.timestamp) ||
  compareText(left.service, right.service) ||
  compareText(left.instanceId, right.instanceId) ||
  compareRecords(left, right);
