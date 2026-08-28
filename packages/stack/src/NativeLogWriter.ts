// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native log paths are synchronous platform-boundary values.
import { join } from "node:path";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Pull,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { LogBuffer, type LogEntry } from "@supabase/process-compose";
import { StackBuildError } from "./errors.ts";
import type { ServiceName } from "./versions.ts";

/** Native journals live below the runtime root and are private to one stack. */
export const nativeLogRoot = (runtimeRoot: string): string => join(runtimeRoot, "logs");

/** Encode arbitrary service labels as one reversible path component. */
const serviceFileName = (service: string): string => encodeURIComponent(service);

/** The active JSONL journal for one native service. Rotated segments append `.1`, `.2`, ... . */
export const nativeServiceLogPath = (runtimeRoot: string, service: ServiceName): string =>
  join(nativeLogRoot(runtimeRoot), `${serviceFileName(service)}.jsonl`);

/**
 * Keep each segment bounded while retaining a small, deterministic history per
 * service. An oversized incoming record is truncated at a Unicode code-point
 * boundary; oversized lines already present at attachment are discarded while
 * the active segment is normalized and rotated.
 */
const NATIVE_LOG_SEGMENT_BYTES = 64 * 1024;
const NATIVE_LOG_SEGMENT_RECORDS = 1_000;
const NATIVE_LOG_SEGMENTS = 3;
/** Retry transient journal failures with interruptible exponential backoff. */
const nativeLogWriteRetry = Schedule.exponential(Duration.millis(50)).pipe(Schedule.jittered);

interface Segment {
  readonly service: string;
  readonly path: string;
  readonly scope: Scope.Closeable;
  readonly file: FileSystem.File;
  bytes: number;
  records: number;
}

const pathForService = (runtimeRoot: string, service: string, index = 0): string => {
  const active = join(nativeLogRoot(runtimeRoot), `${serviceFileName(service)}.jsonl`);
  return index === 0 ? active : `${active}.${index}`;
};

const encodeEntry = (entry: LogEntry): Uint8Array => {
  const encodeMessage = (message: string): Uint8Array =>
    new TextEncoder().encode(
      `${JSON.stringify({
        timestamp: entry.timestamp,
        service: entry.service,
        stream: entry.stream,
        message,
      })}\n`,
    );
  const full = encodeMessage(entry.line);
  if (full.byteLength <= NATIVE_LOG_SEGMENT_BYTES) return full;

  // Truncate only at code-point boundaries, then re-encode to account for JSON
  // escaping. This keeps every journal record valid UTF-8 and below the
  // documented segment bound without splitting a multibyte character.
  const codePoints = Array.from(entry.line);
  let low = 0;
  let high = codePoints.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = codePoints.slice(0, middle).join("");
    if (encodeMessage(candidate).byteLength <= NATIVE_LOG_SEGMENT_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return encodeMessage(best);
};

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

      // Existing journals have no trusted record metadata, so oversized lines
      // are discarded rather than copied past the bound during normalization.
      const normalizeExistingSegment = (path: string): Effect.Effect<string, StackBuildError> =>
        Effect.gen(function* () {
          const content = yield* fs.readFileString(path).pipe(
            Effect.mapError(
              (cause) =>
                new StackBuildError({
                  detail: `Failed to read native log segment ${path}`,
                  cause,
                }),
            ),
          );
          const kept: Array<string> = [];
          let bytes = 0;
          for (const line of content
            .split("\n")
            .filter((line) => line.length > 0)
            .toReversed()) {
            const encoded = new TextEncoder().encode(`${line}\n`);
            if (encoded.byteLength > NATIVE_LOG_SEGMENT_BYTES) continue;
            if (kept.length >= NATIVE_LOG_SEGMENT_RECORDS) break;
            if (bytes + encoded.byteLength > NATIVE_LOG_SEGMENT_BYTES) break;
            kept.unshift(`${line}\n`);
            bytes += encoded.byteLength;
          }
          const normalized = kept.join("");
          if (normalized !== content) {
            yield* fs.writeFileString(path, normalized, { flag: "w", mode: 0o600 }).pipe(
              Effect.mapError(
                (cause) =>
                  new StackBuildError({
                    detail: `Failed to bound native log segment ${path}`,
                    cause,
                  }),
              ),
            );
          }
          return normalized;
        });

      const rotateExistingActive = (activePath: string): Effect.Effect<void, StackBuildError> =>
        Effect.gen(function* () {
          const content = yield* normalizeExistingSegment(activePath);
          if (content.length === 0) return;
          for (let index = NATIVE_LOG_SEGMENTS - 1; index >= 2; index -= 1) {
            const from = `${activePath}.${index - 1}`;
            const to = `${activePath}.${index}`;
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
          yield* fs.rename(activePath, `${activePath}.1`).pipe(
            Effect.mapError(
              (cause) =>
                new StackBuildError({
                  detail: `Failed to attach native log segment ${activePath}`,
                  cause,
                }),
            ),
          );
        });

      const existingEntries = yield* fs.readDirectory(logRoot).pipe(
        Effect.mapError(
          (cause) =>
            new StackBuildError({
              detail: `Failed to inspect native log directory ${logRoot}`,
              cause,
            }),
        ),
      );
      for (const entry of existingEntries.filter((name) => name.endsWith(".jsonl"))) {
        const activePath = join(logRoot, entry);
        for (let index = 1; index < NATIVE_LOG_SEGMENTS; index += 1) {
          const segmentPath = `${activePath}.${index}`;
          const exists = yield* fs.exists(segmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new StackBuildError({
                  detail: `Failed to inspect native log segment ${segmentPath}`,
                  cause,
                }),
            ),
          );
          if (exists) yield* normalizeExistingSegment(segmentPath);
        }
        yield* rotateExistingActive(activePath);
      }

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
          // The handle is now closed. Remove it before any fallible rename or
          // reopen so a retry can acquire a fresh segment instead of reusing
          // stale ownership state.
          segments.delete(current.service);
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

      const writeEntryWithRecovery = (entry: LogEntry): Effect.Effect<void, StackBuildError> =>
        writeEntry(entry).pipe(
          Effect.tapError((error) =>
            Effect.logError(`Native log write failed; retrying ${entry.service}: ${error.detail}`),
          ),
          Effect.retry(nativeLogWriteRetry),
        );

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
            yield* Effect.forEach(chunk, writeEntryWithRecovery, { discard: true });
          }
        }
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof StackBuildError
            ? cause
            : new StackBuildError({ detail: "Native log writer failed", cause }),
        ),
        Effect.tapError((error) =>
          Deferred.fail(subscribed, error).pipe(
            Effect.ignore,
            Effect.andThen(Effect.logError(`Native log writer stopped: ${error.detail}`)),
          ),
        ),
      );

      yield* Effect.forkIn(worker, parentScope, { startImmediately: true });
      yield* Deferred.await(subscribed);
    }),
  );
