/**
 * A plain, full local-database reset — Go's `reset.Run(ctx, "", 0, flags.DbConfig, fsys)`
 * called against the local target (`internal/db/reset/reset.go:57-77`), with an EMPTY
 * version and NO `--last` filtering. Hoisted out of `commands/db/reset/reset.handler.ts`'s
 * own `cfg.isLocal` branch (CLI-1955) so it is callable in-process by any Effect context
 * that provides the services below (CLI-2062) — the two `db schema declarative`
 * call sites (`declarative.smart-target.ts`'s local-reset prompt,
 * `sync.handler.ts`'s failed-apply recovery reset) used to shell out to a SEPARATE
 * `supabase-go` child process for this (`LegacyDeclarativeSeam.execInherit`), which is
 * itself a divergence from real Go: Go's `db schema declarative`/`sync` call
 * `reset.Run` as a plain in-process function, sharing the outer command's own
 * `PersistentPostRun` (telemetry flush / linked-project-cache write) rather than firing
 * a second, independent one from a child process's own `Execute()`. Calling this
 * function in-process collapses back to that single-firing behavior.
 *
 * `db reset`'s own handler is the only caller that ever passes a non-empty
 * `version`/`seedFlags` override (`--version`/`--last`/`--no-seed`/`--sql-paths`) — the
 * declarative callers always want the plain full reset and call with no arguments.
 *
 * Resolves every service it needs (`LegacyDebugFlag`, `LegacyNetworkIdFlag`,
 * `RuntimeInfo`, `ChildProcessSpawner`, `FileSystem`, `Path`, `LegacyCliConfig`, the
 * project `.env` + `legacyResolveExperimentalWithProjectEnv` gate) itself via `yield*`,
 * exactly like `legacyDbReset` did inline before this extraction — so it is
 * self-contained and does not need `LegacyDbResetFlags`/`CliArgs`/
 * `resolveLegacyDbTargetFlags` (the top-level `db reset` command's own flag-parsing
 * concerns, which stay in `reset.handler.ts`).
 *
 * Emits the exact same two stderr lines the removed `execInherit` subprocess used to
 * produce via the Go child's inherited stdio (`Resetting local database...` /
 * `Finished supabase db reset on branch <branch>.`) — always via `output.raw`,
 * regardless of `output.format`, matching a child process's inherited stdio, which
 * never receives `-o`/`--output-format` and always prints Go-native text. Deliberately
 * does NOT emit the JSON `output.success(...)` envelope: that belongs to a real
 * top-level `db reset` invocation only (`reset.handler.ts` emits it itself, after
 * calling this function) — neither Go's in-process `reset.Run` nor the removed
 * `execInherit` subprocess ever produced a machine-JSON envelope for this nested call.
 */

import { Data, Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { detectGitBranch } from "../../../shared/git/git-branch.ts";
import { clearDraftJournalFile } from "../../../shared/schema/clear-draft-journal.ts";
import {
  LegacyDebugFlag,
  LegacyNetworkIdFlag,
  legacyResolveExperimentalWithProjectEnv,
  legacyResolveYesWithProjectEnv,
} from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import { legacyAqua, legacyYellow } from "../legacy-colors.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { legacyCheckDbToml, legacyLoadProjectEnv } from "../legacy-db-config.toml-read.ts";
import { legacySeedBucketsRun } from "../legacy-seed-buckets.ts";
import { legacyAwaitStorageReady } from "./await-storage-ready.ts";
import { legacyBuildLocalDbContainerInputs } from "./local-container-inputs.ts";
import { legacyIsLocalDbRunning } from "./local-db-running.ts";
import { legacyRecreateLocalDatabase } from "./recreate-local-database.ts";

/**
 * The local database container is not running. Byte-matches Go's
 * `utils.ErrNotRunning` (`internal/utils/misc.go:116`), `"<aqua>supabase start</aqua>
 * is not running."`, returned by `AssertSupabaseDbIsRunning` before the local
 * reset (`internal/db/reset/reset.go:57`). Exported only so the exhaustive
 * actionability guard can inspect its declaration; runtime callers consume the
 * enclosing effect rather than importing this class.
 */
export class LegacyResetLocalDbNotRunningError extends Data.TaggedError(
  "LegacyResetLocalDbNotRunningError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/** Go's `toLogMessage` (`internal/db/reset/reset.go:88-91`). */
const toLogMessage = (version: string): string =>
  version.length > 0 ? ` to version: ${version}` : "...";

export interface LegacyResetLocalDatabaseInput {
  /** The resolved reset migration version (`""` for every pending migration, `db reset`'s default). */
  readonly version: string;
  /** `db reset`'s `--no-seed`/`--sql-paths` — see `legacyResolveResetSeedConfig`. */
  readonly seedFlags: { readonly noSeed: boolean; readonly sqlPaths: ReadonlyArray<string> };
}

const PLAIN_FULL_RESET: LegacyResetLocalDatabaseInput = {
  version: "",
  seedFlags: { noSeed: false, sqlPaths: [] },
};

/**
 * Resets the local database in-process. See this module's own header for the full
 * design rationale. Mirrors `internal/db/reset/reset.go:57-77`.
 */
export const legacyResetLocalDatabase = Effect.fnUntraced(function* (
  input: LegacyResetLocalDatabaseInput = PLAIN_FULL_RESET,
) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeInfo = yield* RuntimeInfo;
  const networkIdFlag = yield* LegacyNetworkIdFlag;
  // Threaded into `legacyBuildLocalDbContainerInputs`'s own `setup.debug`, so a failed
  // fresh-volume Realtime/Storage/Auth migrate job on the PG15 recreate path tees its own
  // stderr, matching Go's `initSchema15` passing `utils.GetDebugLogger()` as that job's
  // stderr writer (`start.go:349-353`) — reached by BOTH real Go callers of
  // `SetupLocalDatabase` (`db start` and `db reset`'s PG15 recreate).
  const debug = yield* LegacyDebugFlag;

  const workdir = cliConfig.workdir;
  // Go's `ParseDatabaseConfig` runs `loadNestedEnv` (which `os.Setenv`s each project-.env key)
  // before `reset.Run` reads `viper.GetBool("EXPERIMENTAL")`, so a `SUPABASE_EXPERIMENTAL` set
  // only in `supabase/.env` is honored. Load the project env first and resolve against it, as
  // `legacyDbReset` does for its own experimental gate.
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, workdir);
  const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);
  const experimental = yield* legacyResolveExperimentalWithProjectEnv(projectEnv);

  // Go's `flags.LoadConfig` (root `PersistentPreRunE` → the local target's per-connType
  // `LoadConfig`, `internal/utils/flags/db_url.go:77-80`) runs full config validation before
  // `reset.Run` ever reaches `AssertSupabaseDbIsRunning` / the destructive `resetDatabase`
  // (`internal/db/reset/reset.go:57-61`). Re-validate here as an explicit, independent gate
  // (the same pattern `db start`/`db push` use), so "a malformed config aborts before the
  // local database is recreated" is enforced by this function directly.
  const dbTomlValues = yield* legacyCheckDbToml(fs, path, workdir);

  // AssertSupabaseDbIsRunning — error if the local db container is down.
  const running = yield* legacyIsLocalDbRunning(
    spawner,
    fs,
    path,
    workdir,
    Option.getOrUndefined(cliConfig.projectId),
  );
  if (!running) {
    return yield* Effect.fail(
      new LegacyResetLocalDbNotRunningError({
        message: `${legacyAqua("supabase start")} is not running.`,
      }),
    );
  }
  // resetDatabase: "Resetting local database…" then recreate + migrate + seed.
  yield* output.raw(`Resetting local database${toLogMessage(input.version)}\n`, "stderr");

  // Build the SAME prelude `db start`'s own handler builds (config values +
  // `legacyResolveDbBootstrapConfig`) — Go's `resetDatabase15`/`resetDatabase14`
  // recreate the `db` container with byte-identical inputs to `StartDatabase`'s own.
  const inputs = yield* legacyBuildLocalDbContainerInputs(
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

  yield* legacyRecreateLocalDatabase(spawner, {
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
    // The `[db]` values this function's own validating load above already resolved — what the
    // PG15 recreate's baseline cache keys on, rather than a third silent `config.toml` pass.
    toml: {
      webhooksEnabled: dbTomlValues.webhooksEnabled,
      apiAutoExposeNewTables: dbTomlValues.baseline.apiAutoExposeNewTables,
      vault: dbTomlValues.vault,
    },
    version: input.version,
    seedFlags: input.seedFlags,
    // `db reset` resolves `--experimental` EARLIER than this prelude (it gates the
    // remote-target Go-delegation decision too, reached before `cfg.isLocal` is even
    // known) via the Go-parity nested-env walk (`legacyResolveExperimentalWithProjectEnv`
    // over `projectEnv`, above) — override the prelude's OWN `setup.experimental` (resolved
    // from its `@supabase/config`-backed context instead) with that earlier value, to
    // preserve this pre-existing divergence exactly. See `legacyBuildLocalDbContainerInputs`'s
    // own header.
    setup: { ...setup, experimental },
  });

  yield* clearDraftJournalFile(fs, path, workdir);

  // Seed objects from supabase/buckets when storage is up (Go gates buckets on
  // an existing, healthy storage container). Reuses the ported seed-buckets
  // local path; its summary is suppressed (reset emits its own result).
  const storageReady = yield* legacyAwaitStorageReady(spawner, projectId);
  if (storageReady) {
    // Go's `buckets.Run(ctx, "", false, fsys)` — non-interactive: overwrite/prune
    // confirmations take their defaults instead of blocking on input.
    //
    // `resolvedConfig` passes through the SAME config this function already resolved
    // via `legacyBuildLocalDbContainerInputs`'s `context` (itself loaded through
    // `legacyLoadLocalProjectContext`, which mirrors Go's full nested-env walk —
    // `.env.<SUPABASE_ENV>.local`, `.env.local`, `.env.<SUPABASE_ENV>`, `.env`, across
    // both `supabase/` and the project root, `pkg/config/config.go:1220-1257`) — so
    // `legacySeedBucketsRun` never independently reloads config.toml through
    // `@supabase/config`'s narrower `loadProjectConfig` → `loadProjectEnvironment`
    // (`supabase/.env`/`.env.local` plus ambient env only,
    // `packages/config/src/project.ts:209-245`), which used to reject a config whose
    // `env(VAR)` reference is backed by e.g. `supabase/.env.development` — genuinely
    // Go-valid (Go's `godotenv.Load` calls `os.Setenv`, so the value is real ambient env
    // by the time Go resolves it, `config.go:1260-1261`) and already accepted by
    // `legacyCheckDbToml` and the real recreate above (review CLI-1958). Same pattern
    // `start.handler.ts` already uses for its own `legacySeedBucketsRun` calls.
    yield* legacySeedBucketsRun({
      projectRef: "",
      emitSummary: false,
      interactive: false,
      // Go loads nested env before `buckets.Run`, so `SUPABASE_YES` in `supabase/.env`
      // auto-confirms bucket/vector/analytics prune prompts.
      yes,
      resolvedConfig: { config, document: loaded?.document },
    }).pipe(
      // A genuinely invalid bucket entry (bad name, unparseable `file_size_limit`, …) —
      // recreate already dropped/rebuilt the DB, so aborting now would leave the reset
      // half-done; warn and skip buckets so the reset finishes like Go instead.
      Effect.catchTag("LegacySeedConfigLoadError", (error) =>
        output.raw(
          `${legacyYellow("WARNING:")} skipped seeding storage buckets: ${error.message}\n`,
          "stderr",
        ),
      ),
    );
  }

  // "Finished supabase db reset on branch <branch>." (both Aqua).
  const branch = Option.getOrElse(yield* detectGitBranch(workdir), () => "main");
  yield* output.raw(
    `Finished ${legacyAqua("supabase db reset")} on branch ${legacyAqua(branch)}.\n`,
    "stderr",
  );
});
