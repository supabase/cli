import { BunFileSystem } from "@effect/platform-bun";
import { Data, DateTime, Effect, FileSystem, Layer, Predicate, Random, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import pg from "pg";
import { expect, inject, test as vitestTest } from "vitest";

import { rootCaBundle } from "../../src/commands/gen/types/types.shared.ts";
import {
  type CliRunError,
  requireCliSuccess,
  runSupabase,
  runSupabaseEffect,
  createTempHome,
  helperRejection,
  type TempHome,
} from "./cli.ts";
import { LIVE_EXIT_TIMEOUT_MS, LIVE_SHADOW_PORT } from "./live-env.ts";
import type { LiveCliProjectEnvironment } from "./live-project.ts";

export type LiveProject = LiveCliProjectEnvironment["project"];
type RunOptions = NonNullable<Parameters<typeof runSupabase>[1]>;
type RunResult = Awaited<ReturnType<typeof runSupabase>>;
type RunEffectOptions = Parameters<typeof runSupabaseEffect>[1];

interface LiveWorkspace {
  readonly path: string;
}

export interface InvokeResult {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

export interface LiveFixtures {
  readonly project: LiveProject;
  readonly workspace: LiveWorkspace;
  readonly home: TempHome;
  readonly cli: (args: string[], options?: RunOptions) => Promise<RunResult>;
  readonly cliEffect: (
    args: string[],
    options?: RunEffectOptions,
  ) => Effect.Effect<RunResult, CliRunError>;
  readonly invoke: (
    slug: string,
    options?: { readonly anonKey?: string; readonly payload?: unknown },
  ) => Promise<InvokeResult>;
}

class LiveFixtureError extends Data.TaggedError("LiveFixtureError")<{
  readonly message: string;
}> {}

class LiveForeignFailure extends Data.TaggedError("LiveForeignFailure")<{
  readonly cause: unknown;
}> {}

const foreignFailure = (error: { readonly cause?: unknown }) =>
  new LiveForeignFailure({ cause: error.cause });

const awaitForeign = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new LiveForeignFailure({ cause }) });

const callForeign = <A>(run: () => A) =>
  Effect.try({ try: run, catch: (cause) => new LiveForeignFailure({ cause }) });

/**
 * Runs a helper at its Promise edge, rejecting with a foreign failure's original value and with a
 * plain `Error` for a fixture failure.
 */
function runLive<A>(effect: Effect.Effect<A, LiveFixtureError | LiveForeignFailure>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.catchTags({
        LiveForeignFailure: (failure) => Effect.die(failure.cause),
        LiveFixtureError: (failure) => Effect.die(new Error(failure.message)),
      }),
    ),
  );
}

/** `try { body } finally { cleanup }`: a cleanup failure replaces the body's outcome. */
function withFinally<A, E, R, E2, R2>(
  body: Effect.Effect<A, E, R>,
  cleanup: Effect.Effect<void, E2, R2>,
): Effect.Effect<A, E | E2, R | R2> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(restore(body));
      yield* cleanup;
      return yield* exit;
    }),
  );
}

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);

const invokeFunction = Effect.fnUntraced(function* (
  project: LiveProject,
  slug: string,
  options?: { readonly anonKey?: string; readonly payload?: unknown },
) {
  const key = options?.anonKey ?? project.anonKey;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key.length > 0) {
    headers["Authorization"] = `Bearer ${key}`;
    headers["apikey"] = key;
  }
  const client = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.post(`${project.functionsUrl}/${slug}`).pipe(
    HttpClientRequest.setHeaders(headers),
    HttpClientRequest.bodyJson(options?.payload ?? {}),
  );
  const response = yield* client.execute(request);
  const text = yield* response.text;
  const body = yield* Schema.decodeEffect(UnknownFromJsonString)(text).pipe(
    Effect.orElseSucceed(() => text),
  );
  return { status: response.status, body, text };
});

const base = vitestTest.extend<LiveFixtures>({
  project: ({ task: _task }, use) => use(inject("liveProject")),

  home: ({ task: _task }, use) =>
    runLive(
      /* `try { use } finally { dispose }`: a failed disposal replaces the fixture's outcome. */
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const home = yield* createTempHome.pipe(Effect.mapError(foreignFailure));
          yield* withFinally(
            restore(awaitForeign(() => use(home))),
            home.dispose.pipe(Effect.mapError(foreignFailure)),
          );
        }),
      ),
    ),

  workspace: ({ task, home }, use) =>
    runLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const suffix = task.name.replace(/[^a-z0-9-]+/giu, "-").slice(0, 40);
        const directory = yield* fs
          .makeTempDirectory({ prefix: `supabase-live-${suffix || "test"}-` })
          .pipe(Effect.mapError(foreignFailure));
        yield* withFinally(
          Effect.gen(function* () {
            const initialized = yield* runSupabaseEffect(["init"], {
              cwd: directory,
              home: home.dir,
              env: { SUPABASE_PROFILE: inject("liveProfilePath") },
            }).pipe(
              /* The fixture rejects with what `runSupabase` rejects with for the same failure. */
              Effect.mapError((cause) => new LiveForeignFailure({ cause: helperRejection(cause) })),
            );
            if (initialized.exitCode !== 0) {
              return yield* new LiveFixtureError({
                message: `supabase init failed (exit ${initialized.exitCode})\n${initialized.stderr || initialized.stdout}`,
              });
            }
            yield* awaitForeign(() => use({ path: directory }));
          }),
          fs
            .remove(directory, { recursive: true, force: true })
            .pipe(Effect.mapError(foreignFailure)),
        );
      }).pipe(Effect.provide(BunFileSystem.layer)),
    ),

  cli: ({ workspace, home }, use) =>
    use((args, options) =>
      runSupabase(args, {
        ...options,
        cwd: options?.cwd ?? workspace.path,
        home: home.dir,
        exitTimeoutMs: options?.exitTimeoutMs ?? LIVE_EXIT_TIMEOUT_MS,
        env: {
          SUPABASE_PROFILE: inject("liveProfilePath"),
          SUPABASE_DB_SHADOW_PORT: LIVE_SHADOW_PORT,
          ...options?.env,
        },
      }),
    ),

  cliEffect: ({ workspace, home }, use) =>
    use((args, options) =>
      runSupabaseEffect(args, {
        ...options,
        cwd: options?.cwd ?? workspace.path,
        home: home.dir,
        exitTimeoutMs: options?.exitTimeoutMs ?? LIVE_EXIT_TIMEOUT_MS,
        env: {
          SUPABASE_PROFILE: inject("liveProfilePath"),
          SUPABASE_DB_SHADOW_PORT: LIVE_SHADOW_PORT,
          ...options?.env,
        },
      }),
    ),

  invoke: ({ project }, use) =>
    use((slug, options) =>
      runLive(
        invokeFunction(project, slug, options).pipe(
          Effect.mapError(foreignFailure),
          Effect.provide(
            Layer.mergeAll(
              FetchHttpClient.layer,
              Layer.succeed(HttpClient.TracerPropagationEnabled, false),
            ),
          ),
        ),
      ),
    ),
});

/** The sole live fixture. The live global setup owns the shared project. */
export const test = base;

export { requireCliSuccess as requireLiveSuccess };

/** Parse a command's stdout as JSON, failing with both streams when it is not. */
export function requireLiveJson(
  result: { readonly stdout: string; readonly stderr: string },
  command: string,
): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${command} did not print JSON\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      { cause: error },
    );
  }
}

/** Flags every storage live test passes: the suite links the shared project
 * and the storage command family is experimental-gated. */
export const storageLiveFlags: ReadonlyArray<string> = ["--remote", "--experimental"];

/**
 * Best-effort exact-object cleanup for storage live tests: removes one owned
 * remote object, tolerating an already-removed target so teardown stays
 * idempotent across the moved/renamed paths a test may leave behind.
 */
export function removeStorageLiveObject(
  cli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  remote: string,
): Promise<void> {
  return runLive(
    Effect.gen(function* () {
      const removed = yield* awaitForeign(() =>
        cli(["storage", "rm", remote, "--yes", ...storageLiveFlags]),
      );
      if (
        removed.exitCode !== 0 &&
        !/not found|does not exist/i.test(`${removed.stdout}\n${removed.stderr}`)
      ) {
        return yield* new LiveFixtureError({
          message: `storage rm cleanup failed:\n${removed.stdout}\n${removed.stderr}`,
        });
      }
    }),
  );
}

/** Flags for experimental-gated live tests that address the shared project by
 * ref rather than linking it (contrast `storageLiveFlags`). */
export function experimentalProjectLiveFlags(project: LiveProject): ReadonlyArray<string> {
  return [`--remote=${project.ref}`, "--experimental"];
}

/**
 * Exact-key cleanup for postgres-config live tests: removes one owned override
 * without a database restart. Deleting an absent key is a no-op PUT, so the
 * teardown stays idempotent.
 */
export function removePostgresConfigLiveOverride(
  cli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  project: LiveProject,
  key: string,
): Promise<void> {
  return runLive(
    Effect.gen(function* () {
      const removed = yield* awaitForeign(() =>
        cli([
          "postgres-config",
          "delete",
          "--config",
          key,
          ...experimentalProjectLiveFlags(project),
          "--no-restart",
        ]),
      );
      yield* callForeign(() =>
        requireCliSuccess(removed, `postgres-config delete cleanup for ${key}`),
      );
    }),
  );
}

/** Exact-version cleanup for migration live tests; reverting an absent row is a no-op delete. */
export function removeLiveMigration(
  cli: LiveFixtures["cli"],
  project: LiveProject,
  version: string,
): Promise<void> {
  return runLive(
    Effect.gen(function* () {
      const reverted = yield* awaitForeign(() =>
        cli([
          "migration",
          "repair",
          version,
          "--status",
          "reverted",
          `--remote=${project.dbUrl}`,
          "--yes",
        ]),
      );
      yield* callForeign(() =>
        requireCliSuccess(reverted, `migration repair cleanup for ${version}`),
      );
    }),
  );
}

/**
 * Proves a postgres-config write through `get`. The platform can serve a stale
 * read right after the PUT, so after one fail-fast read the value is polled
 * (2s apart, 60s deadline, each attempt bounded) until `key` reads `expected`
 * (`undefined` for no override).
 */
export function expectPostgresConfigLiveOverride(
  cli: LiveFixtures["cli"],
  project: LiveProject,
  key: string,
  expected: string | undefined,
  label: string,
): Promise<void> {
  const read = Effect.gen(function* () {
    const proof = yield* awaitForeign(() =>
      cli(["postgres-config", "get", ...experimentalProjectLiveFlags(project), "-o", "json"], {
        exitTimeoutMs: 20_000,
      }),
    );
    yield* callForeign(() => requireCliSuccess(proof, label));
    const config = yield* callForeign(() => requireLiveJson(proof, label));
    if (!Predicate.isObject(config)) {
      return yield* new LiveFixtureError({
        message: `${label}: unexpected postgres-config get payload\nstdout:\n${proof.stdout}\nstderr:\n${proof.stderr}`,
      });
    }
    return config[key];
  });
  const readPromise = (): Promise<unknown> => runLive(read);
  /* Polling stays at the Promise edge: vitest's `expect.poll` drives its own reads. */
  return readPromise().then((first) =>
    Object.is(first, expected)
      ? undefined
      : expect
          .poll(readPromise, { interval: 2_000, timeout: 60_000, message: label })
          .toBe(expected),
  );
}

/**
 * Unique migration version for a live test: a sortable `YYYYMMDDHHMMSS` UTC
 * stamp plus four random digits, so it always orders after any conventional
 * timestamp version already in the shared project's migration history.
 */
export function liveMigrationVersion(): string {
  return Effect.runSync(
    Effect.gen(function* () {
      const stamp = DateTime.formatIso(yield* DateTime.now)
        .replaceAll(/[-:TZ.]/gu, "")
        .slice(0, 14);
      const suffix = yield* Random.nextIntBetween(0, 10_000, { halfOpen: true });
      return `${stamp}${suffix.toString().padStart(4, "0")}`;
    }),
  );
}

/**
 * Runs one query against the live project over a direct pg connection, so
 * live assertions can verify database state without invoking another CLI
 * command.
 */
export function queryLiveDb<T extends Record<string, unknown>>(
  dbUrl: string,
  query: string,
  values?: ReadonlyArray<unknown>,
  connectionTimeoutMillis?: number,
): Promise<T[]> {
  return runLive(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // Verified TLS against the Supabase CA, so the query works whatever the project's SSL enforcement.
        const client = yield* callForeign(
          () =>
            new pg.Client({
              connectionString: dbUrl,
              ssl: { ca: rootCaBundle() },
              connectionTimeoutMillis,
            }),
        );
        // A restart that drops an idle or closing client surfaces only as an `error` event.
        client.on("error", () => {});
        yield* restore(awaitForeign(() => client.connect()));
        /* `try { query } finally { end }`: a failed `end()` replaces the query's outcome. */
        return yield* withFinally(
          restore(
            awaitForeign(() =>
              client.query<T>(query, values === undefined ? undefined : [...values]),
            ).pipe(Effect.map((result) => result.rows)),
          ),
          awaitForeign(() => client.end()),
        );
      }),
    ),
  );
}

/** Rethrow a target failure without discarding failures from exact cleanup. */
export function throwWithCleanup(primary: unknown, cleanup: ReadonlyArray<unknown>): void {
  if (primary !== undefined) {
    if (cleanup.length > 0) {
      throw new AggregateError([primary, ...cleanup], "Live e2e target and cleanup failed");
    }
    throw primary;
  }
  if (cleanup.length === 1) throw cleanup[0];
  if (cleanup.length > 1) throw new AggregateError(cleanup, "Live e2e cleanup failed");
}

export function expectFunctionOk(
  result: InvokeResult,
  slug: string,
  extra?: Record<string, unknown>,
): void {
  if (result.status !== 200) {
    throw new Error(
      `Expected function ${slug} to return 200, got ${result.status}: ${result.text}`,
    );
  }
  if (typeof result.body !== "object" || result.body === null) {
    throw new Error(`Expected function ${slug} to return JSON: ${result.text}`);
  }
  const body = result.body as Record<string, unknown>;
  if (body.case !== slug || body.ok !== true) {
    throw new Error(`Unexpected response from ${slug}: ${result.text}`);
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (body[key] !== value) throw new Error(`Unexpected ${key} from ${slug}: ${result.text}`);
  }
}
