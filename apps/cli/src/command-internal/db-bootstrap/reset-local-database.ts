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

/** The local database container is not running. */
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

/** Resets the local database in-process. See this module's own header for the full design rationale. */
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
  // Threaded into `buildLocalDbContainerInputs`'s `setup.debug`, so a failed fresh-volume
  // Realtime/Storage/Auth migrate job on the PG15 recreate path tees its own stderr.
  const debug = yield* DebugFlag;

  const workdir = cliSettings.workdir;
  // Load the project env first so a `SUPABASE_EXPERIMENTAL` set only in `supabase/.env` is
  // honored by the experimental gate below.
  const projectEnv = yield* loadProjectEnv(fs, path, workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);
  const experimental = yield* resolveExperimentalWithProjectEnv(projectEnv);

  // Validate config before checking whether the container is running, so a malformed config
  // aborts before the local database is recreated — the same pattern `db start`/`db push` use.
  yield* checkDbToml(fs, path, workdir);

  // Error if the local db container is down.
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
  // "Resetting local database…" then recreate + migrate + seed.
  yield* output.raw(`Resetting local database${toLogMessage(input.version)}\n`, "stderr");

  // Build the same prelude `db start`'s own handler builds (config values +
  // `resolveDbBootstrapConfig`), so the container is recreated with identical inputs.
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
    // `db reset` has no `fromBackup` concept, so `postgresSpecBase` is already the whole
    // `postgresSpec` here.
    postgresSpec: postgresSpecBase,
    resolvePostgresImage,
    dbHealthTimeoutSeconds: bootstrapConfig.dbHealthTimeoutSeconds,
    version: input.version,
    seedFlags: input.seedFlags,
    // `db reset` resolves `--experimental` earlier than this prelude does, via the nested-env
    // walk above; override the prelude's own `setup.experimental` with that value so the two
    // stay consistent.
    setup: { ...setup, experimental },
  });

  // Seed objects from supabase/buckets when storage is up; summary is suppressed since reset
  // emits its own result.
  const storageReady = yield* awaitStorageReady(spawner, projectId);
  if (storageReady) {
    // Non-interactive: overwrite/prune confirmations take their defaults instead of blocking on
    // input. `resolvedConfig` reuses the config already resolved via
    // `buildLocalDbContainerInputs`'s full nested-env walk, so `seedBucketsRun` never
    // independently reloads config.toml through a narrower env resolution that could reject a
    // config whose `env(VAR)` reference is backed by a non-default dotenv file. Same pattern
    // `start.handler.ts` uses for its own `seedBucketsRun` calls.
    yield* seedBucketsRun({
      projectRef: "",
      emitSummary: false,
      interactive: false,
      // `SUPABASE_YES` set in `supabase/.env` auto-confirms bucket/vector/analytics prune
      // prompts.
      yes,
      resolvedConfig: { config, document: loaded?.document },
      // The same nested-dotenv walk already resolved for `yes`/`experimental` above.
      projectEnvValues: projectEnv,
    }).pipe(
      // An invalid bucket entry (bad name, unparseable `file_size_limit`, …) can't abort here —
      // recreate already dropped/rebuilt the DB — so warn and skip buckets instead.
      Effect.catchTag("SeedConfigLoadError", (error) =>
        output.raw(
          `${yellow("WARNING:")} skipped seeding storage buckets: ${error.message}\n`,
          "stderr",
        ),
      ),
    );
  }

  const branch = Option.getOrElse(yield* detectGitBranch(workdir), () => "main");
  yield* output.raw(`Finished ${aqua("supabase db reset")} on branch ${aqua(branch)}.\n`, "stderr");
});
