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
import { legacyGetHostname } from "../../../../../shared/legacy-hostname.ts";
import {
  legacyReadDbToml,
  legacyResolveDeclarativeDir,
} from "../../../../../shared/legacy-db-config.toml-read.ts";
import { legacyToPostgresURL } from "../../../../../shared/legacy-postgres-url.ts";
import { LegacyTelemetryState } from "../../../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyListLocalMigrations } from "../declarative.cache.ts";
import {
  LegacyDeclarativeInvalidDbUrlError,
  LegacyDeclarativeMutuallyExclusiveFlagsError,
  LegacyDeclarativeNonInteractiveError,
} from "../declarative.errors.ts";
import { legacyRequirePgDelta } from "../declarative.gate.ts";
import {
  type LegacyDeclarativeRunContext,
  legacyGenerateDeclarativeOutput,
} from "../declarative.orchestrate.ts";
import { legacyWriteDeclarativeSchemas } from "../declarative.write.ts";
import type { LegacyDbSchemaDeclarativeGenerateFlags } from "./generate.command.ts";

interface LocalConn {
  readonly port: number;
  readonly password: string;
}

const localUrl = (local: LocalConn): string =>
  legacyToPostgresURL({
    // Go derives the local host from `utils.Config.Hostname` (`GetHostname()`:
    // SUPABASE_SERVICES_HOSTNAME → tcp DOCKER_HOST → 127.0.0.1), not a hardcoded
    // loopback (`apps/cli-go/internal/utils/misc.go:298-312`).
    host: legacyGetHostname(),
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
      // cobra `MarkFlagsMutuallyExclusive("db-url", "linked", "local")`
      // (`apps/cli-go/cmd/db_schema_declarative.go:499`) runs before PreRunE/RunE,
      // so reject conflicting targets before reading config or the pg-delta gate.
      // "Set" follows cobra's `Changed`: Option set when `Some`, boolean when `true`.
      const exclusive: Array<string> = [];
      if (Option.isSome(flags.dbUrl)) exclusive.push("db-url");
      if (flags.linked) exclusive.push("linked");
      if (flags.local) exclusive.push("local");
      if (exclusive.length > 1) {
        return yield* Effect.fail(
          new LegacyDeclarativeMutuallyExclusiveFlagsError({
            message: `if any flags in the group [db-url linked local] are set none of the others can be; [${exclusive.join(" ")}] were all set`,
          }),
        );
      }

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
        // Go's confirmOverwrite goes through Console.PromptYesNo, which returns true
        // immediately when the global YES flag is set (`apps/cli-go/internal/utils/
        // console.go:70-73`). Honor --yes here too, or non-interactive/JSON runs
        // would error on the prompt and a TTY would block despite --yes.
        const ok = yes
          ? true
          : yield* output.promptConfirm(
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
