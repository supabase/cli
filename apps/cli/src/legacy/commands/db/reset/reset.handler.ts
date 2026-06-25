import {
  loadProjectConfig,
  type LoadProjectConfigOptions,
  ProjectConfigSchema,
} from "@supabase/config";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { legacyApplyMigrations } from "../../../shared/legacy-migration-apply.ts";
import { legacyPromptYesNo } from "../../../shared/legacy-prompt-yes-no.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyDropUserSchemas } from "../shared/legacy-drop-schemas.ts";
import { legacyListLocalMigrations } from "../shared/legacy-pgdelta.cache.ts";
import { legacyGetPendingSeeds, legacySeedData } from "../shared/legacy-seed-ops.ts";
import { legacyReadVaultDocument, legacyUpsertVaultSecrets } from "../shared/legacy-vault.ts";
import type { LegacyDbResetFlags } from "./reset.command.ts";
import {
  LegacyDbResetApplyError,
  LegacyDbResetCancelledError,
  LegacyDbResetConfigLoadError,
  LegacyDbResetInvalidVersionError,
  LegacyDbResetMigrationFileError,
  LegacyDbResetTargetFlagsError,
  LegacyDbResetVersionFlagsError,
} from "./reset.errors.ts";

const decodeDefaultConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

const INTEGER_PATTERN = /^[+-]?\d+$/u;
const MIGRATE_FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/u;

const applyError = (message: string) => new LegacyDbResetApplyError({ message });

/** Go's `toLogMessage` (`internal/db/reset/reset.go:88-91`). */
const toLogMessage = (version: string): string =>
  version.length > 0 ? ` to version: ${version}` : "...";

/** Rebuilds the `db reset` argv for the Go-delegated (local / experimental) paths. */
const buildResetArgs = (flags: LegacyDbResetFlags): Array<string> => {
  const args = ["db", "reset"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  if (flags.noSeed) args.push("--no-seed");
  if (Option.isSome(flags.version)) args.push("--version", flags.version.value);
  if (Option.isSome(flags.last)) args.push("--last", String(flags.last.value));
  return args;
};

/**
 * `supabase db reset` — reinitialise a database from local migrations (+ seed).
 *
 * Strict 1:1 port of `apps/cli-go/internal/db/reset/reset.go`. The remote path
 * (`--linked` / a remote `--db-url`) is native. The local path (and the niche
 * `--experimental` schema-files path) delegate to the Go binary as a documented
 * interim until the container-bootstrap seam is ported (CLI-1325 Stage 3).
 */
export const legacyDbReset = Effect.fn("legacy.db.reset")(function* (flags: LegacyDbResetFlags) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const dbConn = yield* LegacyDbConnection;
  const proxy = yield* LegacyGoProxy;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliArgs = yield* CliArgs;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const experimental = yield* LegacyExperimentalFlag;
  const yes = yield* legacyResolveYes;

  const workdir = cliConfig.workdir;
  const migrationsDir = path.join(workdir, "supabase", "migrations");
  let linkedRefForCache: string | undefined;

  const body = Effect.gen(function* () {
    const target = resolveLegacyDbTargetFlags(cliArgs.args);
    // cobra MarkFlagsMutuallyExclusive("db-url", "linked", "local").
    if (target.setFlags.length > 1) {
      return yield* Effect.fail(
        new LegacyDbResetTargetFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
        }),
      );
    }
    // cobra MarkFlagsMutuallyExclusive("version", "last") — alphabetical group.
    if (Option.isSome(flags.version) && Option.isSome(flags.last)) {
      return yield* Effect.fail(
        new LegacyDbResetVersionFlagsError({
          message:
            "if any flags in the group [last version] are set none of the others can be; [last version] were all set",
        }),
      );
    }

    // Version / last resolution (Go's reset.Run lines 34-52), filesystem only.
    let resolvedVersion = "";
    if (Option.isSome(flags.version)) {
      const v = flags.version.value;
      if (!INTEGER_PATTERN.test(v)) {
        return yield* Effect.fail(
          new LegacyDbResetInvalidVersionError({
            message: `failed to parse ${v}: invalid version number`,
          }),
        );
      }
      const locals = yield* legacyListLocalMigrations(fs, path, migrationsDir);
      const found = locals.some((p) => path.basename(p).startsWith(`${v}_`));
      if (!found) {
        return yield* Effect.fail(
          new LegacyDbResetMigrationFileError({
            message: `glob supabase/migrations/${v}_*.sql: file does not exist`,
          }),
        );
      }
      resolvedVersion = v;
    } else if (Option.isSome(flags.last) && flags.last.value > 0) {
      const locals = yield* legacyListLocalMigrations(fs, path, migrationsDir);
      const versions = locals.flatMap((p) => {
        const m = MIGRATE_FILE_PATTERN.exec(path.basename(p));
        return m?.[1] !== undefined ? [m[1]] : [];
      });
      const total = versions.length;
      const last = flags.last.value;
      resolvedVersion = last < total ? versions[total - last - 1]! : "-";
    }

    const connType = target.connType ?? "local";
    const cfg = yield* resolver.resolve({ dbUrl: flags.dbUrl, connType, dnsResolver });

    // Local target → container reset, not yet ported. Delegate to the Go binary
    // (telemetry disabled so the TS instrumentation wrapper counts the run once).
    if (cfg.isLocal) {
      yield* proxy.exec(buildResetArgs(flags), { env: { SUPABASE_TELEMETRY_DISABLED: "1" } });
      return;
    }

    // Remote path. The niche `--experimental` schema-files apply path
    // (`apply.MigrateAndSeed`) is not ported; delegate it too.
    if (experimental && resolvedVersion === "") {
      yield* proxy.exec(buildResetArgs(flags), { env: { SUPABASE_TELEMETRY_DISABLED: "1" } });
      return;
    }

    const linkedRef = Option.getOrUndefined(cfg.ref ?? Option.none());
    if (connType === "linked" && linkedRef !== undefined) linkedRefForCache = linkedRef;

    const loadOptions: LoadProjectConfigOptions | undefined =
      connType === "linked" && linkedRef !== undefined ? { projectRef: linkedRef } : undefined;
    const loaded = yield* loadProjectConfig(workdir, loadOptions).pipe(
      Effect.catchTag(
        "ProjectConfigParseError",
        (cause) =>
          new LegacyDbResetConfigLoadError({
            message: `failed to parse supabase/config.toml: ${String(cause.cause)}`,
          }),
      ),
    );
    const config = loaded === null ? decodeDefaultConfig({}) : loaded.config;
    const document = loaded === null ? undefined : loaded.document;
    if (loaded !== null && loaded.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
    }

    // Go's resetRemote: prompt (default false) → cancel, then ResetAll.
    const shouldReset = yield* legacyPromptYesNo(
      output,
      yes,
      "Do you want to reset the remote database?",
      false,
    );
    if (!shouldReset) {
      return yield* Effect.fail(new LegacyDbResetCancelledError({ message: "context canceled" }));
    }
    yield* output.raw(`Resetting remote database${toLogMessage(resolvedVersion)}\n`, "stderr");

    // Go connects with io.Discard, so NO "Connecting to ... database..." line.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* dbConn.connect(cfg.conn, { isLocal: false, dnsResolver });
        // ResetAll: drop user schemas → upsert vault → migrate + seed.
        yield* legacyDropUserSchemas(session, applyError);
        yield* legacyUpsertVaultSecrets(session, legacyReadVaultDocument(document), applyError);

        if (config.db.migrations.enabled) {
          const locals = yield* legacyListLocalMigrations(fs, path, migrationsDir);
          // LoadPartialMigrations filter: version === "" || v <= version.
          const pending = locals.filter((p) => {
            if (resolvedVersion === "") return true;
            const m = MIGRATE_FILE_PATTERN.exec(path.basename(p));
            return m?.[1] !== undefined && m[1] <= resolvedVersion;
          });
          yield* legacyApplyMigrations(session, fs, path, pending, applyError);
        }

        // `--no-seed` forces seed disabled (Go sets Config.Db.Seed.Enabled=false).
        if (config.db.seed.enabled && !flags.noSeed) {
          const seeds = yield* legacyGetPendingSeeds(
            session,
            fs,
            path,
            config.db.seed.sql_paths,
            workdir,
          );
          yield* legacySeedData(session, fs, workdir, path, seeds, applyError);
        }
        // Go's best-effort pgcache catalog warning is not ported (no output impact).
      }),
    );

    if (output.format !== "text") {
      yield* output.success("Reset remote database.", {
        target: "remote",
        version: resolvedVersion,
      });
    }
  });

  yield* body.pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        linkedRefForCache !== undefined && linkedRefForCache !== ""
          ? linkedProjectCache.cache(linkedRefForCache)
          : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
