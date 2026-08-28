// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native log paths are synchronous platform-boundary values.
import { join } from "node:path";
import { Deferred, Effect, Exit, FileSystem, Pull, Scope, Stream } from "effect";
import { LogBuffer, type LogEntry } from "@supabase/process-compose";
import { StackBuildError } from "./errors.ts";
import type { ServiceName } from "./versions.ts";

/** Native journals live below the runtime root and are private to one stack. */
export const nativeLogRoot = (runtimeRoot: string): string => join(runtimeRoot, "logs");

/** The active JSONL journal for one native service. Rotated segments append `.1`, `.2`, ... . */
export const nativeServiceLogPath = (runtimeRoot: string, service: ServiceName): string =>
  join(nativeLogRoot(runtimeRoot), `${service}.jsonl`);

/** Keep each segment bounded while retaining a small, deterministic history per service. */
const NATIVE_LOG_SEGMENT_BYTES = 64 * 1024;
const NATIVE_LOG_SEGMENT_RECORDS = 1_000;
const NATIVE_LOG_SEGMENTS = 3;

interface Segment {
  readonly service: string;
  readonly path: string;
  readonly scope: Scope.Closeable;
  readonly file: FileSystem.File;
  bytes: number;
  records: number;
}

const pathForService = (runtimeRoot: string, service: string, index = 0): string => {
  const active = join(nativeLogRoot(runtimeRoot), `${service}.jsonl`);
  return index === 0 ? active : `${active}.${index}`;
};

const encodeEntry = (entry: LogEntry): Uint8Array =>
  new TextEncoder().encode(
    `${JSON.stringify({
      timestamp: entry.timestamp,
      service: entry.service,
      stream: entry.stream,
      message: entry.line,
    })}\n`,
  );

/**
 * Starts one scoped subscriber for a stack's native LogBuffer. The subscriber
 * is deliberately a sliding LogBuffer consumer: child-process appenders never
 * wait for filesystem I/O, while this fiber serializes each service's journal.
 */
export const startNativeLogWriter = (
  logBuffer: LogBuffer["Service"],
  runtimeRoot: string,
): Effect.Effect<void, StackBuildError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.suspend(() =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parentScope = yield* Effect.scope;
      const logRoot = nativeLogRoot(runtimeRoot);
      yield* fs.makeDirectory(logRoot, { recursive: true, mode: 0o700 }).pipe(
        Effect.mapError(
          (cause) =>
            new StackBuildError({
              detail: `Failed to create native log directory ${logRoot}`,
              cause,
            }),
        ),
      );

      const segments = new Map<string, Segment>();
      const openSegment = (service: string): Effect.Effect<Segment, StackBuildError> =>
        Effect.gen(function* () {
          const segmentScope = yield* Scope.fork(parentScope, "sequential");
          const path = pathForService(runtimeRoot, service);
          const opened = yield* fs.open(path, { flag: "a", mode: 0o600 }).pipe(
            Effect.provideService(Scope.Scope, segmentScope),
            Effect.mapError(
              (cause) =>
                new StackBuildError({
                  detail: `Failed to open native service log ${path}`,
                  cause,
                }),
            ),
            Effect.onError(() => Scope.close(segmentScope, Exit.void)),
          );
          const info = yield* opened.stat.pipe(
            Effect.mapError(
              (cause) =>
                new StackBuildError({
                  detail: `Failed to inspect native service log ${path}`,
                  cause,
                }),
            ),
            Effect.onError(() => Scope.close(segmentScope, Exit.void)),
          );
          return {
            service,
            path,
            scope: segmentScope,
            file: opened,
            bytes: Number(info.size),
            records: 0,
          } satisfies Segment;
        });

      const rotate = (current: Segment): Effect.Effect<Segment, StackBuildError> =>
        Effect.gen(function* () {
          yield* current.file.sync.pipe(
            Effect.mapError(
              (cause) =>
                new StackBuildError({
                  detail: `Failed to flush native service log ${current.path}`,
                  cause,
                }),
            ),
          );
          yield* Scope.close(current.scope, Exit.void);
          for (let index = NATIVE_LOG_SEGMENTS - 1; index >= 1; index -= 1) {
            const from = pathForService(runtimeRoot, current.service, index - 1);
            const to = pathForService(runtimeRoot, current.service, index);
            const exists = yield* fs.exists(from).pipe(
              Effect.mapError(
                (cause) =>
                  new StackBuildError({
                    detail: `Failed to inspect native log segment ${from}`,
                    cause,
                  }),
              ),
            );
            if (exists) {
              yield* fs.rename(from, to).pipe(
                Effect.mapError(
                  (cause) =>
                    new StackBuildError({
                      detail: `Failed to rotate native log segment ${from}`,
                      cause,
                    }),
                ),
              );
            }
          }
          return yield* openSegment(current.service);
        });

      const writeEntry = (entry: LogEntry): Effect.Effect<void, StackBuildError> =>
        Effect.gen(function* () {
          let segment = segments.get(entry.service);
          if (segment === undefined) {
            segment = yield* openSegment(entry.service);
            segments.set(entry.service, segment);
          }
          const bytes = encodeEntry(entry);
          if (
            segment.bytes > 0 &&
            (segment.bytes + bytes.byteLength > NATIVE_LOG_SEGMENT_BYTES ||
              segment.records >= NATIVE_LOG_SEGMENT_RECORDS)
          ) {
            segment = yield* rotate(segment);
            segments.set(entry.service, segment);
          }
          yield* segment.file.writeAll(bytes).pipe(
            Effect.mapError(
              (cause) =>
                new StackBuildError({
                  detail: `Failed to append native service log ${segment.path}`,
                  cause,
                }),
            ),
          );
          segment.bytes += bytes.byteLength;
          segment.records += 1;
        });

      const subscribed = Deferred.makeUnsafe<void, StackBuildError>();
      const worker = Effect.gen(function* () {
        const pull = yield* Stream.toPull(logBuffer.subscribeAll);
        yield* Deferred.succeed(subscribed, undefined);
        let running = true;
        while (running) {
          const chunk = yield* pull.pipe(Pull.catchDone(() => Effect.succeed(null)));
          if (chunk === null) {
            running = false;
          } else {
            yield* Effect.forEach(chunk, writeEntry, { discard: true });
          }
        }
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof StackBuildError
            ? cause
            : new StackBuildError({ detail: "Native log writer failed", cause }),
        ),
        Effect.tapError((error) => Deferred.fail(subscribed, error).pipe(Effect.ignore)),
      );

      yield* Effect.forkIn(worker, parentScope, { startImmediately: true });
      yield* Deferred.await(subscribed);
    }),
  );
