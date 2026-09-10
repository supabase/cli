/**
 * Resets the local database in-process — shared by `db reset`'s handler and the `db schema
 * declarative`/`sync` local-reset paths, so neither needs to shell out to a separate process.
 * `db reset`'s own handler is the only caller that ever passes a non-empty
 * `version`/`seedFlags` override; the declarative callers always want the plain full reset.
 *
 * Always prints its own two stderr lines via `output.raw`, regardless of `output.format`, but
 * never the JSON `output.success(...)` envelope — that belongs to a top-level `db reset`
 * invocation only, emitted by its own handler after calling this function.
 */

import { Data, Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { detectGitBranch } from "../../shared/git/git-branch.ts";
import {
  DebugFlag,
  NetworkIdFlag,
  resolveExperimentalWithProjectEnv,
  resolveYesWithProjectEnv,
} from "../global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { aqua, yellow } from "../colors.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { checkDbToml, loadProjectEnv } from "../db-config.toml-read.ts";
import { seedBucketsRun } from "../seed-buckets.ts";
import { awaitStorageReady } from "./await-storage-ready.ts";
import { buildLocalDbContainerInputs } from "./local-container-inputs.ts";
import { isLocalDbRunning } from "./local-db-running.ts";
import { recreateLocalDatabase } from "./recreate-local-database.ts";

/**
 * The local database container is not running. Exported only so the exhaustive actionability
 * guard can inspect its declaration; runtime callers consume the enclosing effect instead.
 */
class ResetLocalDbNotRunningError extends Data.TaggedError("ResetLocalDbNotRunningError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/** ` to version: X`, or `...` when resetting to the latest migration. */
const toLogMessage = (version: string): string =>
  version.length > 0 ? ` to version: ${version}` : "...";

export interface ResetLocalDatabaseInput {
  /** The resolved reset migration version (`""` for every pending migration, `db reset`'s default). */
  readonly version: string;
  /** `db reset`'s `--no-seed`/`--sql-paths` — see `resolveResetSeedConfig`. */
  readonly seedFlags: { readonly noSeed: boolean; readonly sqlPaths: ReadonlyArray<string> };
}

const PLAIN_FULL_RESET: ResetLocalDatabaseInput = {
  version: "",
  seedFlags: { noSeed: false, sqlPaths: [] },
};

/**
 * Resets the local database in-process. See this module's own header for the full
 * design rationale. Mirrors `internal/db/reset/reset.go:57-77`.
 */
export const resetLocalDatabase = Effect.fnUntraced(function* (
  input: ResetLocalDatabaseInput = PLAIN_FULL_RESET,
) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeInfo = yield* RuntimeInfo;
  const networkIdFlag = yield* NetworkIdFlag;
  // Threaded into `buildLocalDbContainerInputs`'s own `setup.debug`, so a failed
  // fresh-volume Realtime/Storage/Auth migrate job on the PG15 recreate path tees its own
  // stderr, matching Go's `initSchema15` passing `utils.GetDebugLogger()` as that job's
  // stderr writer (`start.go:349-353`) — reached by BOTH real Go callers of
  // `SetupLocalDatabase` (`db start` and `db reset`'s PG15 recreate).
  const debug = yield* DebugFlag;

  const workdir = cliSettings.workdir;
  // Go's `ParseDatabaseConfig` runs `loadNestedEnv` (which `os.Setenv`s each project-.env key)
  // before `reset.Run` reads `viper.GetBool("EXPERIMENTAL")`, so a `SUPABASE_EXPERIMENTAL` set
  // only in `supabase/.env` is honored. Load the project env first and resolve against it, as
  // `dbReset` does for its own experimental gate.
  const projectEnv = yield* loadProjectEnv(fs, path, workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);
  const experimental = yield* resolveExperimentalWithProjectEnv(projectEnv);

  // Go's `flags.LoadConfig` (root `PersistentPreRunE` → the local target's per-connType
  // `LoadConfig`, `internal/utils/flags/db_url.go:77-80`) runs full config validation before
  // `reset.Run` ever reaches `AssertSupabaseDbIsRunning` / the destructive `resetDatabase`
  // (`internal/db/reset/reset.go:57-61`). Re-validate here as an explicit, independent gate
  // (the same pattern `db start`/`db push` use), so "a malformed config aborts before the
  // local database is recreated" is enforced by this function directly.
  yield* checkDbToml(fs, path, workdir);

  // AssertSupabaseDbIsRunning — error if the local db container is down.
  const running = yield* isLocalDbRunning(
    spawner,
    fs,
    path,
    workdir,
    Option.getOrUndefined(cliSettings.projectId),
  );
  if (!running) {
    return yield* Effect.fail(
      new ResetLocalDbNotRunningError({
        message: `${aqua("supabase start")} is not running.`,
      }),
    );
  }
  // resetDatabase: "Resetting local database…" then recreate + migrate + seed.
  yield* output.raw(`Resetting local database${toLogMessage(input.version)}\n`, "stderr");

  // Build the SAME prelude `db start`'s own handler builds (config values +
  // `resolveDbBootstrapConfig`) — Go's `resetDatabase15`/`resetDatabase14`
  // recreate the `db` container with byte-identical inputs to `StartDatabase`'s own.
  const inputs = yield* buildLocalDbContainerInputs(
    spawner,
    workdir,
    networkIdFlag,
    runtimeInfo.platform,
    debug,
  );
  const {
    context: { projectId, hostname, config, loaded },
    values,
    bootstrapConfig,
    networkId,
    containerOpts,
    dbContainerId,
    postgresSpecBase,
    resolvePostgresImage,
    setup,
  } = inputs;

  yield* recreateLocalDatabase(spawner, {
    fs,
    path,
    workdir,
    projectId,
    networkId,
    hostname,
    dbContainerId,
    dbPort: values.dbPort,
    containerOpts,
    // `db reset` has no `fromBackup` concept at all, so `postgresSpecBase` — the
    // exact same fields `db start` splices its own `fromBackup` on top of — is
    // already this composition's WHOLE `postgresSpec`.
    postgresSpec: postgresSpecBase,
    resolvePostgresImage,
    dbHealthTimeoutSeconds: bootstrapConfig.dbHealthTimeoutSeconds,
    version: input.version,
    seedFlags: input.seedFlags,
    // `db reset` resolves `--experimental` EARLIER than this prelude (it gates the
    // remote-target Go-delegation decision too, reached before `cfg.isLocal` is even
    // known) via the Go-parity nested-env walk (`resolveExperimentalWithProjectEnv`
    // over `projectEnv`, above) — override the prelude's OWN `setup.experimental` (resolved
    // from its `@supabase/config`-backed context instead) with that earlier value, to
    // preserve this pre-existing divergence exactly. See `buildLocalDbContainerInputs`'s
    // own header.
    setup: { ...setup, experimental },
  });

  // Seed objects from supabase/buckets when storage is up (Go gates buckets on
  // an existing, healthy storage container). Reuses the ported seed-buckets
  // local path; its summary is suppressed (reset emits its own result).
  const storageReady = yield* awaitStorageReady(spawner, projectId);
  if (storageReady) {
    // Go's `buckets.Run(ctx, "", false, fsys)` — non-interactive: overwrite/prune
    // confirmations take their defaults instead of blocking on input.
    //
    // `resolvedConfig` passes through the SAME config this function already resolved
    // via `buildLocalDbContainerInputs`'s `context` (itself loaded through
    // `loadLocalProjectContext`, which mirrors Go's full nested-env walk —
    // `.env.<SUPABASE_ENV>.local`, `.env.local`, `.env.<SUPABASE_ENV>`, `.env`, across
    // both `supabase/` and the project root, `pkg/config/config.go:1220-1257`) — so
    // `seedBucketsRun` never independently reloads config.toml through
    // `@supabase/config`'s narrower `loadCliConfig` → `loadCliProjectEnvironment`
    // (`supabase/.env`/`.env.local` plus ambient env only,
    // `packages/config/src/project.ts:209-245`), which used to reject a config whose
    // `env(VAR)` reference is backed by e.g. `supabase/.env.development` — genuinely
    // Go-valid (Go's `godotenv.Load` calls `os.Setenv`, so the value is real ambient env
    // by the time Go resolves it, `config.go:1260-1261`) and already accepted by
    // `checkDbToml` and the real recreate above (review CLI-1958). Same pattern
    // `start.handler.ts` already uses for its own `seedBucketsRun` calls.
    yield* seedBucketsRun({
      projectRef: "",
      emitSummary: false,
      interactive: false,
      // Go loads nested env before `buckets.Run`, so `SUPABASE_YES` in `supabase/.env`
      // auto-confirms bucket/vector/analytics prune prompts.
      yes,
      resolvedConfig: { config, document: loaded?.document },
      // The same nested-dotenv walk this function already resolved for
      // `yes`/`experimental` above — no independent reload in the seed core.
      projectEnvValues: projectEnv,
    }).pipe(
      // A genuinely invalid bucket entry (bad name, unparseable `file_size_limit`, …) —
      // recreate already dropped/rebuilt the DB, so aborting now would leave the reset
      // half-done; warn and skip buckets so the reset finishes like Go instead.
      Effect.catchTag("SeedConfigLoadError", (error) =>
        output.raw(
          `${yellow("WARNING:")} skipped seeding storage buckets: ${error.message}\n`,
          "stderr",
        ),
      ),
    );
  }

  // "Finished supabase db reset on branch <branch>." (both Aqua).
  const branch = Option.getOrElse(yield* detectGitBranch(workdir), () => "main");
  yield* output.raw(`Finished ${aqua("supabase db reset")} on branch ${aqua(branch)}.\n`, "stderr");
});
