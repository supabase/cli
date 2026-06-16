import { Effect, FileSystem, Option, Path } from "effect";

import {
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyYesFlag,
} from "../../../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../../../shared/legacy/go-proxy.service.ts";
import { Output } from "../../../../../../shared/output/output.service.ts";
import { Tty } from "../../../../../../shared/runtime/tty.service.ts";
import { LegacyCliConfig } from "../../../../../config/legacy-cli-config.service.ts";
import { legacyBold } from "../../../../../shared/legacy-colors.ts";
import { LegacyDbConfigResolver } from "../../../../../shared/legacy-db-config.service.ts";
import {
  legacyReadDbToml,
  legacyResolveDeclarativeDir,
} from "../../../../../shared/legacy-db-config.toml-read.ts";
import { legacyToPostgresURL } from "../../../../../shared/legacy-postgres-url.ts";
import { LegacyTelemetryState } from "../../../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyListLocalMigrations } from "../declarative.cache.ts";
import {
  LegacyDeclarativeInvalidDbUrlError,
  LegacyDeclarativeNonInteractiveError,
} from "../declarative.errors.ts";
import { legacyRequirePgDelta } from "../declarative.gate.ts";
import {
  type LegacyDeclarativeRunContext,
  legacyGenerateDeclarativeOutput,
} from "../declarative.orchestrate.ts";
import { legacyWriteDeclarativeSchemas } from "../declarative.write.ts";
import type { LegacyDbSchemaDeclarativeGenerateFlags } from "./generate.command.ts";

const LOCAL_HOST = "127.0.0.1";

interface LocalConn {
  readonly port: number;
  readonly password: string;
}

const localUrl = (local: LocalConn): string =>
  legacyToPostgresURL({
    host: LOCAL_HOST,
    port: local.port,
    user: "postgres",
    password: local.password,
    database: "postgres",
  });

export const legacyDbSchemaDeclarativeGenerate = Effect.fn("legacy.db.schema.declarative.generate")(
  function* (flags: LegacyDbSchemaDeclarativeGenerateFlags) {
    const output = yield* Output;
    const tty = yield* Tty;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliConfig = yield* LegacyCliConfig;
    const telemetryState = yield* LegacyTelemetryState;
    const experimental = yield* LegacyExperimentalFlag;
    const yes = yield* LegacyYesFlag;

    yield* Effect.gen(function* () {
      const toml = yield* legacyReadDbToml(fs, path, cliConfig.workdir);
      yield* legacyRequirePgDelta({
        experimental,
        pgDeltaEnabled: toml.pgDelta.enabled,
        configPath: path.join("supabase", "config.toml"),
      });

      const declarativeDir = path.join(
        cliConfig.workdir,
        legacyResolveDeclarativeDir(path, toml.pgDelta),
      );
      const migrationsDir = path.join(cliConfig.workdir, "supabase", "migrations");
      const local: LocalConn = { port: toml.port, password: toml.password };

      const run: LegacyDeclarativeRunContext = {
        pgDelta: {
          projectId: Option.getOrElse(cliConfig.projectId, () => ""),
          cwd: cliConfig.workdir,
          npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
        },
        formatOptions: Option.getOrElse(toml.pgDelta.formatOptions, () => ""),
        declarativeDir,
        schema: flags.schema,
        noCache: flags.noCache,
      };

      const hasExplicitTarget = flags.local || flags.linked || Option.isSome(flags.dbUrl);

      let targetUrl: string;
      let overwrite: boolean;
      if (hasExplicitTarget) {
        targetUrl = flags.local ? localUrl(local) : yield* resolveRemoteUrl(flags);
        overwrite = flags.overwrite;
      } else {
        if (!tty.stdinIsTty && !yes) {
          return yield* Effect.fail(
            new LegacyDeclarativeNonInteractiveError({
              message: "in non-interactive mode, specify a target: --local, --linked, or --db-url",
            }),
          );
        }
        if ((yield* hasDeclarativeFiles(fs, declarativeDir)) && !flags.overwrite) {
          const ok = yield* output.promptConfirm(
            `Declarative schema already exists at ${legacyBold(
              declarativeDir,
            )}. Regenerate from database? This will overwrite existing files.`,
            { defaultValue: false },
          );
          if (!ok) {
            yield* output.raw("Skipped generating declarative schema.\n", "stderr");
            return;
          }
        }
        const hasMigrations = yield* hasMigrationFiles(fs, path, migrationsDir);
        targetUrl = yield* resolveSmartTargetUrl(flags, local, hasMigrations);
        overwrite = true;
      }

      const result = yield* legacyGenerateDeclarativeOutput(run, targetUrl);

      if (!overwrite && (yield* hasDeclarativeFiles(fs, declarativeDir))) {
        const ok = yield* output.promptConfirm(
          "Overwrite declarative schema? Existing files may be deleted.",
          { defaultValue: false },
        );
        if (!ok) {
          yield* output.raw("Skipped writing declarative schema.\n", "stderr");
          return;
        }
      }

      yield* legacyWriteDeclarativeSchemas(fs, path, declarativeDir, result);
      yield* output.raw(`Declarative schema written to ${legacyBold(declarativeDir)}\n`, "stderr");
    }).pipe(Effect.ensuring(telemetryState.flush));
  },
);

const hasDeclarativeFiles = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, dir: string) {
  const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return false;
  const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
  return entries.length > 0;
});

const hasMigrationFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) {
  const migrations = yield* legacyListLocalMigrations(fs, path, migrationsDir);
  return migrations.length > 0;
});

/** Resolves `--linked` / `--db-url` to a Postgres URL via the shared resolver. */
const resolveRemoteUrl = Effect.fnUntraced(function* (
  flags: LegacyDbSchemaDeclarativeGenerateFlags,
) {
  const resolver = yield* LegacyDbConfigResolver;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const resolved = yield* resolver.resolve({
    dbUrl: flags.dbUrl,
    linked: flags.linked,
    local: false,
    dnsResolver,
    password: flags.password,
  });
  return legacyToPostgresURL(resolved.conn);
});

/** Smart-mode (no explicit target) interactive target resolution. */
const resolveSmartTargetUrl = Effect.fnUntraced(function* (
  flags: LegacyDbSchemaDeclarativeGenerateFlags,
  local: LocalConn,
  hasMigrations: boolean,
) {
  if (!hasMigrations) return localUrl(local);

  const output = yield* Output;
  const choice = yield* output.promptSelect("Generate declarative schema from:", [
    { value: "local", label: "Local database", hint: "generate from local Postgres" },
    { value: "custom", label: "Custom database URL", hint: "enter a connection string" },
  ]);

  if (choice === "custom") {
    const dbURL = yield* output.promptText("Enter database URL: ");
    if (dbURL.trim().length === 0) {
      return yield* Effect.fail(
        new LegacyDeclarativeInvalidDbUrlError({ message: "database URL cannot be empty" }),
      );
    }
    return dbURL;
  }

  let shouldReset = flags.reset;
  if (!shouldReset) {
    shouldReset = yield* output.promptConfirm(
      "Reset local database to match migrations first? (local data will be lost)",
      { defaultValue: false },
    );
  }
  if (shouldReset) {
    // `db reset` is not yet ported natively; delegate to the bundled Go binary.
    const proxy = yield* LegacyGoProxy;
    yield* proxy.exec(["db", "reset", "--local"]);
  }
  return localUrl(local);
});
