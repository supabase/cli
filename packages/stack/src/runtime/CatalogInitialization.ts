import { Effect, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { NativeProcessSpec } from "./NativeProcess.ts";
import { defaultNativeProcessLauncher, spawnNativeProcess } from "./NativeProcess.ts";
import type { RuntimeWorkloadKey } from "./RuntimeDriver.ts";
import { StackRuntimeError } from "../public/Errors.ts";
import { makeProcessOutputTail } from "./Diagnostics.ts";

const databaseHostKeys = new Set([
  "DB_HOST",
  "GOTRUE_DB_HOST",
  "POSTGRES_HOST",
  "PGHOST",
  "PG_META_DB_HOST",
]);
const databasePortKeys = new Set([
  "DB_PORT",
  "GOTRUE_DB_PORT",
  "POSTGRES_PORT",
  "PGPORT",
  "PG_META_DB_PORT",
]);
const databasePasswordKeys = new Set([
  "DB_PASSWORD",
  "GOTRUE_DB_PASSWORD",
  "POSTGRES_PASSWORD",
  "PGPASSWORD",
  "PG_META_DB_PASSWORD",
]);

/** Rewrites only database connection coordinates for a catalog one-shot. */
export const rewriteCatalogDatabaseEnvironment = (
  environment: Readonly<Record<string, string>>,
  target: Readonly<{ host: string; port: number; password: string }>,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (databaseHostKeys.has(name)) {
      result[name] = target.host;
      continue;
    }
    if (databasePortKeys.has(name)) {
      result[name] = String(target.port);
      continue;
    }
    if (databasePasswordKeys.has(name)) {
      result[name] = target.password;
      continue;
    }
    try {
      const parsed = new URL(value);
      if (["postgres:", "postgresql:", "ecto:"].includes(parsed.protocol)) {
        parsed.hostname = target.host;
        parsed.port = String(target.port);
        parsed.password = target.password;
        result[name] = parsed.toString();
        continue;
      }
    } catch {
      // Non-URL environment values pass through unchanged.
    }
    result[name] = value;
  }
  return result;
};

/** Runs one catalog-owned native initialization process for an active database instance. */
export const runCatalogNativeProcess = (
  spec: NativeProcessSpec,
  key: RuntimeWorkloadKey,
  knownSecrets: ReadonlyArray<string> = [],
): Effect.Effect<void, StackRuntimeError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* spawnNativeProcess(spec, defaultNativeProcessLauncher(), key).pipe(
        Effect.mapError(
          (error) =>
            new StackRuntimeError({
              message: error.message,
              stackId: key.stackId,
              workloadId: key.workloadId,
              cause: error,
            }),
        ),
      );
      const tail = makeProcessOutputTail();
      const drain = Effect.all(
        [
          Stream.runForEach(process.stdout, (bytes) =>
            Effect.sync(() => tail.pushBytes("stdout", bytes)),
          ),
          Stream.runForEach(process.stderr, (bytes) =>
            Effect.sync(() => tail.pushBytes("stderr", bytes)),
          ),
        ],
        { concurrency: "unbounded", discard: true },
      );
      const [exitCode] = yield* Effect.all([process.exitCode, drain], {
        concurrency: "unbounded",
      }).pipe(
        Effect.timeoutOrElse({
          duration: spec.timeout ?? "5 minutes",
          orElse: () =>
            Effect.fail(
              new StackRuntimeError({
                message: `Native catalog initialization timed out for ${key.workloadId}`,
                stackId: key.stackId,
                workloadId: key.workloadId,
              }),
            ),
        }),
        Effect.mapError((error) =>
          error instanceof StackRuntimeError
            ? error
            : new StackRuntimeError({
                message: "Native catalog initialization failed",
                stackId: key.stackId,
                workloadId: key.workloadId,
                cause: error,
              }),
        ),
      );
      if (exitCode !== 0) {
        const diagnostic = tail.finish(knownSecrets);
        return yield* new StackRuntimeError({
          message:
            diagnostic.length === 0
              ? `Native catalog initialization exited with code ${String(exitCode)} for ${key.workloadId}`
              : diagnostic,
          stackId: key.stackId,
          workloadId: key.workloadId,
        });
      }
    }),
  );
