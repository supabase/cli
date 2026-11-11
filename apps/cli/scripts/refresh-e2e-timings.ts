// Rewrites apps/cli/tests/e2e-timings.json from the Vitest results caches that the test-e2e
// workflow job uploads as `e2e-timings-<shard>` artifacts.
import { constants } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BunServices } from "@effect/platform-bun";
import { Console, Data, Effect, FileSystem, Path, Predicate, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { version as installedVitestVersion } from "vitest/node";

export interface VitestFileResult {
  readonly duration: number;
  readonly failed: boolean;
}

/** Shape of Vitest's `results.json` cache: `[<project>:<root-relative path>, result]` entries. */
export interface VitestResultsCache {
  readonly version: string;
  readonly results: ReadonlyArray<readonly [string, VitestFileResult]>;
}

export interface MergeOptions {
  /** Version of the Vitest that will consume the timings; caches from another major are rejected. */
  readonly vitestVersion: string;
  readonly warn?: (message: string) => void;
}

const PROJECT_PREFIXES = ["e2e:", "e2e-exclusive:"];

function major(version: string): string {
  return version.split(".")[0] ?? version;
}

/**
 * Merges e2e project entries from several results caches into `{ path: ms }`, sorted by path.
 * Failed entries are skipped since their duration reflects the failure, not the file.
 */
export function mergeTimings(
  caches: ReadonlyArray<VitestResultsCache>,
  { vitestVersion, warn = () => {} }: MergeOptions,
): Record<string, number> {
  const merged = new Map<string, number>();
  for (const cache of caches) {
    if (major(cache.version) !== major(vitestVersion)) {
      throw new Error(
        `results cache was written by Vitest ${cache.version} but Vitest ${vitestVersion} is installed`,
      );
    }
    for (const [key, result] of cache.results) {
      const prefix = PROJECT_PREFIXES.find((candidate) => key.startsWith(candidate));
      if (prefix === undefined) {
        continue;
      }
      const path = key.slice(prefix.length);
      if (result.failed) {
        warn(`skipping failed ${path}`);
        continue;
      }
      const duration = Math.round(result.duration);
      merged.set(path, Math.max(merged.get(path) ?? 0, duration));
    }
  }
  return Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function isFileResult(value: unknown): value is VitestFileResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "duration" in value &&
    typeof value.duration === "number" &&
    "failed" in value &&
    typeof value.failed === "boolean"
  );
}

function isResultsEntry(value: unknown): value is readonly [string, VitestFileResult] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    isFileResult(value[1])
  );
}

function isResultsCache(value: unknown): value is VitestResultsCache {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string" &&
    "results" in value &&
    Array.isArray(value.results) &&
    value.results.every(isResultsEntry)
  );
}

class RefreshTimingsError extends Data.TaggedError("RefreshTimingsError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const platformMessage = (error: { readonly message: string; readonly cause?: unknown }) =>
  error.cause instanceof Error ? error.cause.message : error.message;

const toRefreshTimingsError = (error: { readonly message: string; readonly cause?: unknown }) =>
  new RefreshTimingsError({ message: platformMessage(error), cause: error });

const dieWithHostError = (error: { readonly cause?: unknown }) => Effect.die(error.cause ?? error);

const encodeTimingsJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

const receivedSignal = (error: { readonly message: string; readonly cause?: unknown }) =>
  /^Process interrupted due to receipt of signal: '(.+)'$/.exec(platformMessage(error))?.[1];

const hostCode = (error: { readonly cause?: unknown }) =>
  Predicate.hasProperty(error.cause, "code") ? error.cause.code : undefined;

/**
 * Lists the regular files under `dir` breadth first, in directory order, following symlinked
 * directories but never counting a symlink as a file.
 * Only `fs.readLink`'s "not a symlink" answer (`EINVAL`) marks a plain entry; a link, or one
 * `readLink` is denied on (a mode-000 link on macOS), is a symlink. A directory that cannot be
 * listed fails the whole listing, reported against `dir`.
 */
const listRegularFiles = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files: string[] = [];
    const directories = [{ path: dir, viaSymlink: false }];
    for (let next = directories.shift(); next !== undefined; next = directories.shift()) {
      const current = next;
      const names = yield* fs.readDirectory(current.path).pipe(
        Effect.catch((error) => {
          const code = hostCode(error);
          return current.viaSymlink && (code === "ENOTDIR" || code === "ENOENT")
            ? Effect.succeed([])
            : Effect.fail(
                new RefreshTimingsError({
                  message: platformMessage(error).replace(`'${current.path}'`, `'${dir}'`),
                  cause: error,
                }),
              );
        }),
      );
      for (const name of names) {
        const entry = path.join(current.path, name);
        const isSymlink = yield* fs.readLink(entry).pipe(
          Effect.as(true),
          Effect.catchTag("PlatformError", (error) => Effect.succeed(hostCode(error) !== "EINVAL")),
        );
        if (isSymlink) {
          directories.push({ path: entry, viaSymlink: true });
          continue;
        }
        const type = yield* fs.stat(entry).pipe(
          Effect.map((info) => info.type),
          Effect.orElseSucceed(() => undefined),
        );
        if (type === "Directory") {
          directories.push({ path: entry, viaSymlink: false });
        } else if (type === "File") {
          files.push(entry);
        }
      }
    }
    return files;
  });

/* Keeps a leading byte order mark, which the default decoder drops, so the JSON parse sees it. */
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/* A plain parse, so malformed JSON reports the parser's own message. */
function parseJson(text: string): unknown {
  return JSON.parse(text);
}

const readResultsCaches = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const caches: VitestResultsCache[] = [];
    for (const file of yield* listRegularFiles(dir)) {
      if (path.basename(file) !== "results.json") {
        continue;
      }
      const text = utf8.decode(yield* fs.readFile(file));
      const parsed = yield* Effect.try({
        try: () => parseJson(text),
        catch: (cause) =>
          new RefreshTimingsError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      if (!isResultsCache(parsed)) {
        return yield* new RefreshTimingsError({ message: `${file} is not a Vitest results cache` });
      }
      caches.push(parsed);
    }
    return caches;
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(toRefreshTimingsError(error))));

const usage = `Usage: bun apps/cli/scripts/refresh-e2e-timings.ts --run <run-id> [--repo supabase/cli]

  Downloads the e2e-timings-* artifacts of a test workflow run and rewrites
  apps/cli/tests/e2e-timings.json from them.`;

const refresh = (run: string, repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const downloadDir = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ prefix: "e2e-timings-" }).pipe(Effect.catch(dieWithHostError)),
      (dir) =>
        fs.remove(dir, { recursive: true, force: true }).pipe(Effect.catch(dieWithHostError)),
    );
    const program = Effect.gen(function* () {
      const exitCode = yield* Effect.scoped(
        Effect.gen(function* () {
          const download = yield* spawner
            .spawn(
              ChildProcess.make(
                "gh",
                [
                  "run",
                  "download",
                  run,
                  "--repo",
                  repo,
                  "--pattern",
                  "e2e-timings-*",
                  "--dir",
                  downloadDir,
                ],
                { detached: false, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
              ),
            )
            .pipe(
              Effect.mapError(
                (error) =>
                  new RefreshTimingsError({
                    message: `could not run gh: ${platformMessage(error)}`,
                    cause: error,
                  }),
              ),
              Effect.catchDefect((defect) =>
                Effect.fail(
                  new RefreshTimingsError({
                    message: `could not run gh: ${defect instanceof Error ? defect.message : String(defect)}`,
                    cause: defect,
                  }),
                ),
              ),
            );
          return yield* download.exitCode.pipe(
            Effect.mapError((error) => {
              const signal = receivedSignal(error);
              return new RefreshTimingsError({
                message:
                  signal === undefined
                    ? `gh run download failed: ${platformMessage(error)}`
                    : `gh run download exited with signal ${signal}`,
                cause: error,
              });
            }),
          );
        }),
      );
      if (exitCode !== 0) {
        return yield* new RefreshTimingsError({
          message: `gh run download exited with ${exitCode}`,
        });
      }

      const caches = yield* readResultsCaches(downloadDir);
      if (caches.length === 0) {
        return yield* new RefreshTimingsError({
          message: `no results.json found in the e2e-timings-* artifacts of run ${run}`,
        });
      }
      const timings = yield* Console.consoleWith((out) =>
        Effect.try({
          try: () =>
            mergeTimings(caches, {
              vitestVersion: installedVitestVersion,
              warn: (message) => out.error(message),
            }),
          catch: (cause) =>
            new RefreshTimingsError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }),
      );
      const target = fileURLToPath(new URL("../tests/e2e-timings.json", import.meta.url));
      const json = yield* encodeTimingsJson({ version: 1, files: timings });
      yield* fs.writeFileString(target, `${json}\n`).pipe(Effect.mapError(toRefreshTimingsError));
      yield* Console.error(`wrote ${Object.keys(timings).length} timings to ${target}`);
    });
    yield* program.pipe(
      Effect.catch((error) =>
        Console.error(`error: ${error.message}`).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const isSignal = (name: string): name is NodeJS.Signals => Object.hasOwn(constants.signals, name);

/**
 * Holds every signal that already has a handler (Vitest's exit hook) until the run, cleanup
 * included, has finished, then raises each held signal again, in arrival order.
 */
const holdSignals = <A, E, R>(run: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const received: Array<NodeJS.Signals> = [];
    const hold = (signal: NodeJS.Signals) => {
      received.push(signal);
    };
    const signals = Object.keys(constants.signals)
      .filter(isSignal)
      .filter((signal) => process.listenerCount(signal) > 0);
    const originalListeners = signals.map((signal) => ({
      signal,
      listeners: process.rawListeners(signal),
    }));
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        for (const { signal, listeners } of originalListeners) {
          process.on(signal, hold);
          for (const listener of listeners) {
            process.off(signal, listener);
          }
        }
      }),
      () =>
        Effect.sync(() => {
          for (const { signal, listeners } of originalListeners) {
            for (const listener of listeners) {
              process.on(signal, listener);
            }
            process.off(signal, hold);
          }
          for (const signal of received) {
            process.kill(process.pid, signal);
          }
        }),
    );
    return yield* run;
  }).pipe(Effect.scoped);

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { run: { type: "string" }, repo: { type: "string", default: "supabase/cli" } },
  });
  if (!values.run) {
    await Effect.runPromise(Console.error(usage));
    process.exit(2);
  }

  await Effect.runPromise(
    holdSignals(refresh(values.run, values.repo).pipe(Effect.provide(BunServices.layer))),
  );
}
