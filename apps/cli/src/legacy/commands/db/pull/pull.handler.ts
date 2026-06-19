import { Clock, Effect, FileSystem, Option, Path } from "effect";

import {
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyYesFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyAqua, legacyBold } from "../../../shared/legacy-colors.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import {
  legacyReadDbToml,
  legacyResolveDeclarativeDir,
} from "../../../shared/legacy-db-config.toml-read.ts";
import type { LegacyDbConnType } from "../../../shared/legacy-db-target-flags.ts";
import { legacyToPostgresURL } from "../../../shared/legacy-postgres-url.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyWriteDeclarativeSchemas } from "../shared/legacy-pgdelta.write.ts";
import {
  legacyParseBoolEnv,
  legacyResolvePullDiffEngine,
  legacyShouldUsePgDelta,
} from "../shared/legacy-diff-engine.ts";
import { legacyDiffMigra } from "../shared/legacy-migra.ts";
import {
  legacyFormatMigrationTimestamp,
  legacyGetMigrationPath,
} from "../shared/legacy-migration-file.ts";
import {
  type LegacyPgDeltaContext,
  legacyDeclarativeExportPgDelta,
  legacyDiffPgDelta,
} from "../shared/legacy-pgdelta.ts";
import { LegacyDeclarativeSeam } from "../shared/legacy-pgdelta.seam.service.ts";
import type { LegacyDbPullFlags } from "./pull.command.ts";
import {
  LegacyDbPullEngineConflictError,
  LegacyDbPullInSyncError,
  LegacyDbPullMigrationConflictError,
  LegacyDbPullTargetFlagsError,
  LegacyDbPullWriteError,
} from "./pull.errors.ts";
import {
  legacyListRemoteMigrations,
  legacyLoadLocalVersions,
  legacyReconcileMigrations,
  legacyUpdateMigrationHistory,
} from "./pull.sync.ts";

// pflag's `MarkDeprecated` emits `"Flag --%s has been deprecated, %s\n"` with the
// registration message verbatim (`apps/cli-go/cmd/db.go:466`), which ends with a `.`.
const DEPRECATION_LINE =
  "Flag --use-pg-delta has been deprecated, use --declarative with [experimental.pgdelta] enabled = true in your config.toml instead.";

/** Builds a plain Postgres URL from a resolved connection (Go's `ToPostgresURL`). */
const connToUrl = (conn: LegacyPgConnInput): string =>
  legacyToPostgresURL({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    ...(conn.options !== undefined ? { options: conn.options } : {}),
    ...(conn.runtimeParams !== undefined ? { runtimeParams: conn.runtimeParams } : {}),
    // Preserve a `--db-url` connect_timeout; Go's ToPostgresURL serializes the
    // parsed ConnectTimeout (`connect.go`), defaulting to 10 only when unset.
    ...(conn.connectTimeoutSeconds !== undefined
      ? { connectTimeoutSeconds: conn.connectTimeoutSeconds }
      : {}),
  });

/** Rebuilds the `db pull` argv for the Go-delegated branches (initial-migra / EXPERIMENTAL dump). */
const rebuildDelegateArgs = (flags: LegacyDbPullFlags): Array<string> => {
  const args = ["db", "pull"];
  if (Option.isSome(flags.name)) args.push(flags.name.value);
  const pushBool = (name: string, value: Option.Option<boolean>) => {
    // Only forward an explicitly-true boolean (a `Some(false)` equals the default).
    if (Option.isSome(value) && value.value) args.push(`--${name}`);
  };
  pushBool("declarative", flags.declarative);
  pushBool("use-pg-delta", flags.usePgDelta);
  if (Option.isSome(flags.diffEngine)) args.push("--diff-engine", flags.diffEngine.value);
  for (const s of flags.schema) args.push("--schema", s);
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  pushBool("linked", flags.linked);
  pushBool("local", flags.local);
  if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
  return args;
};

export const legacyDbPull = Effect.fn("legacy.db.pull")(function* (flags: LegacyDbPullFlags) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const connection = yield* LegacyDbConnection;
  const seam = yield* LegacyDeclarativeSeam;
  const proxy = yield* LegacyGoProxy;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const yes = yield* LegacyYesFlag;
  const experimental = yield* LegacyExperimentalFlag;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;

  let linkedRefForCache: string | undefined;

  yield* Effect.gen(function* () {
    const name = Option.getOrElse(flags.name, () => "remote_schema");
    // `--declarative` and the deprecated `--use-pg-delta` both select declarative
    // output (Go binds both to `useDeclarative`, `cmd/db.go:464-465`).
    const useDeclarative =
      Option.getOrElse(flags.declarative, () => false) ||
      Option.getOrElse(flags.usePgDelta, () => false);
    if (Option.isSome(flags.usePgDelta)) {
      yield* output.raw(`${DEPRECATION_LINE}\n`, "stderr");
    }

    // cobra mutex groups: `[db-url linked local]`, `[declarative diff-engine]`,
    // `[use-pg-delta diff-engine]` (`cmd/db.go:472-474`). "set" = pflag `Changed`.
    const targetSet: Array<string> = [];
    if (Option.isSome(flags.dbUrl)) targetSet.push("db-url");
    if (Option.isSome(flags.linked)) targetSet.push("linked");
    if (Option.isSome(flags.local)) targetSet.push("local");
    if (targetSet.length > 1) {
      return yield* Effect.fail(
        new LegacyDbPullTargetFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${[...targetSet].sort().join(" ")}] were all set`,
        }),
      );
    }
    for (const [flagName, present] of [
      ["declarative", Option.isSome(flags.declarative)],
      ["use-pg-delta", Option.isSome(flags.usePgDelta)],
    ] as const) {
      if (present && Option.isSome(flags.diffEngine)) {
        return yield* Effect.fail(
          new LegacyDbPullEngineConflictError({
            message: `if any flags in the group [${flagName} diff-engine] are set none of the others can be; [${[flagName, "diff-engine"].sort().join(" ")}] were all set`,
          }),
        );
      }
    }

    const connType: LegacyDbConnType = Option.isSome(flags.dbUrl)
      ? "db-url"
      : Option.isSome(flags.local)
        ? "local"
        : "linked";
    const resolved = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType,
      dnsResolver,
      password: flags.password ?? Option.none(),
    });
    const linkedRef = Option.getOrUndefined(resolved.ref ?? Option.none());
    if (linkedRef !== undefined) linkedRefForCache = linkedRef;
    const targetUrl = connToUrl(resolved.conn);

    const toml = yield* legacyReadDbToml(fs, path, cliConfig.workdir);
    const ctx: LegacyPgDeltaContext = {
      projectId: Option.getOrElse(cliConfig.projectId, () => ""),
      cwd: cliConfig.workdir,
      npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
      denoVersion: toml.denoVersion,
    };
    const formatOptions = Option.getOrElse(toml.pgDelta.formatOptions, () => "");

    const usePgDeltaDiff = legacyResolvePullDiffEngine({
      engineFlagChanged: Option.isSome(flags.diffEngine),
      engine: Option.getOrElse(flags.diffEngine, () => "migra"),
      pgDeltaDefault: legacyShouldUsePgDelta({
        configEnabled: toml.pgDelta.enabled,
        usePgDeltaFlag: false,
        envEnabled: legacyParseBoolEnv(toml.envLookup("SUPABASE_EXPERIMENTAL_PG_DELTA")),
      }),
    });

    // Connectivity check (Go's `ConnectByConfig` at the top of `pull.Run`).
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* connection.connect(resolved.conn, {
          isLocal: resolved.isLocal,
          dnsResolver,
        });

        // Declarative export path (Go's `pullDeclarativePgDelta`).
        if (useDeclarative) {
          yield* output.raw("Preparing declarative schema export using pg-delta...\n", "stderr");
          const declarativeDir = path.resolve(
            cliConfig.workdir,
            legacyResolveDeclarativeDir(path, toml.pgDelta),
          );
          const shadow = yield* seam.provisionShadow({
            mode: "declarative",
            targetLocal: false,
            usePgDelta: true,
            schema: flags.schema,
          });
          const exported = yield* legacyDeclarativeExportPgDelta(ctx, {
            sourceRef: shadow.sourceUrl,
            targetRef: targetUrl,
            schema: flags.schema,
            formatOptions,
          }).pipe(Effect.ensuring(seam.removeShadowContainer(shadow.container)));
          yield* legacyWriteDeclarativeSchemas(fs, path, declarativeDir, exported).pipe(
            Effect.mapError((cause) => new LegacyDbPullWriteError({ message: cause.message })),
          );
          yield* output.raw(
            `Declarative schema written to ${legacyBold(declarativeDir)}\n`,
            "stderr",
          );
          if (output.format !== "text") {
            yield* output.success("Declarative schema pulled.", {
              declarative: true,
              schemaWritten: declarativeDir,
              remoteHistoryUpdated: false,
              engine: "pg-delta",
            });
          } else {
            yield* output.raw(`Finished ${legacyAqua("supabase db pull")}.\n`);
          }
          return;
        }

        // Go's `EXPERIMENTAL` structured-dump branch depends on unported `pg_dump`
        // — delegate the whole pull to Go. viper resolves `EXPERIMENTAL` from
        // *either* the global `--experimental` pflag or `SUPABASE_EXPERIMENTAL`
        // (`cmd/root.go:318-320,327,334`), so honor both forms here; the legacy
        // root only forwards `--experimental` to Go proxy argv, never into env.
        if (experimental || legacyParseBoolEnv(toml.envLookup("SUPABASE_EXPERIMENTAL"))) {
          yield* proxy.exec(rebuildDelegateArgs(flags), {
            env: { SUPABASE_TELEMETRY_DISABLED: "1" },
          });
          return;
        }

        // Migration-file path (Go's `pull.run`).
        const timestamp = legacyFormatMigrationTimestamp(yield* Clock.currentTimeMillis);
        const migrationPath = legacyGetMigrationPath(path, cliConfig.workdir, timestamp, name);

        const remote = yield* legacyListRemoteMigrations(session);
        const local = yield* legacyLoadLocalVersions(
          fs,
          path,
          path.join(cliConfig.workdir, "supabase", "migrations"),
        );
        const sync = legacyReconcileMigrations(remote, local);
        if (sync.kind === "conflict") {
          return yield* Effect.fail(
            new LegacyDbPullMigrationConflictError({
              message:
                "The remote database's migration history does not match local files in supabase/migrations directory.",
              suggestion: sync.suggestion,
            }),
          );
        }
        if (sync.kind === "missing" && !usePgDeltaDiff) {
          // Initial pull with the migra engine needs `pg_dump` — delegate to Go.
          yield* proxy.exec(rebuildDelegateArgs(flags), {
            env: { SUPABASE_TELEMETRY_DISABLED: "1" },
          });
          return;
        }

        // Native diff: shadow (baseline + local migrations) vs remote → migration SQL.
        // For the initial pull (no local migrations) the schema filter is ignored,
        // matching Go's `diffRemoteSchema(ctx, nil, …)`.
        const diffSchema = sync.kind === "missing" ? [] : flags.schema;
        // Go's `DiffDatabase` emits these to stderr before provisioning + diffing
        // (`internal/db/diff/diff.go:189,234-237`); the shadow seam doesn't, so the
        // pull handler emits them itself to match the migration-style `db pull` output.
        yield* output.raw("Creating shadow database...\n", "stderr");
        const shadow = yield* seam.provisionShadow({
          mode: "diff",
          // Mirror Go's `DiffDatabase` → `PrepareShadowSource(ctx, schema,
          // utils.IsLocalDatabase(config), …)` (`internal/db/diff/diff.go:190`):
          // a local target with declarative schema files gets a second
          // `contrib_regression` shadow returned as the target override.
          targetLocal: resolved.isLocal,
          usePgDelta: usePgDeltaDiff,
          schema: diffSchema,
        });
        const out = yield* Effect.gen(function* () {
          // Use the declarative target override when present (Go substitutes it
          // for the diff target, `diff.go:196-197`); for remote pulls it's
          // undefined, so this is the direct target URL as before.
          const target = shadow.targetUrlOverride ?? targetUrl;
          yield* output.raw(
            diffSchema.length > 0
              ? `Diffing schemas: ${diffSchema.join(",")}\n`
              : "Diffing schemas...\n",
            "stderr",
          );
          if (usePgDeltaDiff) {
            const result = yield* legacyDiffPgDelta(ctx, {
              sourceRef: shadow.sourceUrl,
              targetRef: target,
              schema: diffSchema,
              formatOptions,
            });
            return result.sql;
          }
          return yield* legacyDiffMigra(ctx, {
            source: shadow.sourceUrl,
            target,
            schema: diffSchema,
            connectOptions: { isLocal: resolved.isLocal, dnsResolver },
          });
        }).pipe(Effect.ensuring(seam.removeShadowContainer(shadow.container)));

        if (out.trim().length === 0) {
          return yield* Effect.fail(
            new LegacyDbPullInSyncError({ message: "No schema changes found" }),
          );
        }
        yield* fs
          .makeDirectory(path.dirname(migrationPath), { recursive: true })
          .pipe(Effect.mapError((cause) => new LegacyDbPullWriteError({ message: cause.message })));
        yield* fs.writeFileString(migrationPath, out).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyDbPullWriteError({
                message: `failed to write migration file: ${cause.message}`,
              }),
          ),
        );
        yield* output.raw(`Schema written to ${legacyBold(migrationPath)}\n`, "stderr");

        // Prompt to update the remote migration history table. Go calls
        // `PromptYesNo(ctx, "Update remote migration history table?", true)`
        // (`internal/db/pull/pull.go:73`), which returns the default (`true`) on
        // `--yes`, on a non-interactive stdin, or on any prompt error
        // (`internal/utils/console.go:74-82`) — it never fails the command.
        let remoteHistoryUpdated = false;
        const updateHistoryTitle = "Update remote migration history table?";
        const shouldUpdate = yield* Effect.gen(function* () {
          // Machine output (json/stream-json) never prompts — the non-text layers
          // report non-interactive and fail every prompt — so take Go's default.
          if (output.format !== "text") return true;
          if (yes) {
            yield* output.raw(`${updateHistoryTitle} [Y/n] y\n`, "stderr");
            return true;
          }
          // A non-interactive stdin or any prompt error falls back to the default,
          // matching Go's `PromptYesNo` returning `def` on error/timeout.
          return yield* output
            .promptConfirm(updateHistoryTitle, { defaultValue: true })
            .pipe(Effect.orElseSucceed(() => true));
        });
        if (shouldUpdate) {
          yield* legacyUpdateMigrationHistory(session, fs, path, migrationPath, timestamp);
          remoteHistoryUpdated = true;
        }

        if (output.format !== "text") {
          yield* output.success("Schema pulled.", {
            declarative: false,
            schemaWritten: migrationPath,
            remoteHistoryUpdated,
            engine: usePgDeltaDiff ? "pg-delta" : "migra",
          });
        } else {
          yield* output.raw(`Finished ${legacyAqua("supabase db pull")}.\n`);
        }
      }),
    );
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        linkedRefForCache !== undefined ? linkedProjectCache.cache(linkedRefForCache) : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
