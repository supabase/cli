import { Effect, type FileSystem, Option, type Path } from "effect";

import {
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
} from "../../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { PROJECT_REF_PATTERN } from "../../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../../shared/legacy-db-config.service.ts";
import { legacyLoadProjectEnv } from "../../../../shared/legacy-db-config.toml-read.ts";
import {
  parseLegacyConnectionString,
  redactLegacyConnectionString,
} from "../../../../shared/legacy-db-config.parse.ts";
import { legacyGetHostname } from "../../../../shared/legacy-hostname.ts";
import { legacyToPostgresURL } from "../../../../shared/legacy-postgres-url.ts";
import {
  LegacyDeclarativeApplyError,
  LegacyDeclarativeInvalidDbUrlError,
} from "./declarative.errors.ts";
import { LegacyDeclarativeSeam } from "./declarative.seam.service.ts";

/**
 * The local connection bits the smart-target resolver needs (Go reads these from
 * the merged config's `[db]`).
 */
export interface LegacyLocalConn {
  readonly port: number;
  readonly password: string;
}

/**
 * The flag surface the smart-target resolver reads. Both `generate` (passing its
 * full flags) and `sync` (constructing a target-less value for its bootstrap)
 * satisfy this, mirroring Go passing the same `cmd` into `runDeclarativeGenerate`.
 */
export interface LegacySmartTargetFlags {
  readonly dbUrl: Option.Option<string>;
  // Presence-modelled (Go's `flag.Changed`), like `--db-url`. The resolver only
  // reads `dbUrl` to pick db-url vs linked, so this is carried for type-compat.
  readonly linked: Option.Option<boolean>;
  readonly password: Option.Option<string>;
  readonly reset: boolean;
}

export const legacyLocalUrl = (local: LegacyLocalConn): string =>
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

/** Resolves `--linked` / `--db-url` to a Postgres URL via the shared resolver. */
export const legacyResolveRemoteUrl = Effect.fnUntraced(function* (flags: LegacySmartTargetFlags) {
  const resolver = yield* LegacyDbConfigResolver;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const resolved = yield* resolver.resolve({
    dbUrl: flags.dbUrl,
    // Remote-only resolution: `--db-url` wins, otherwise the linked project.
    connType: Option.isSome(flags.dbUrl) ? "db-url" : "linked",
    dnsResolver,
    password: flags.password,
  });
  return legacyToPostgresURL(resolved.conn);
});

/**
 * Smart-mode (no explicit target) interactive target resolution — Go's
 * `runDeclarativeGenerate` smart branch (`apps/cli-go/cmd/db_schema_declarative.go:198-298`).
 * Shared by `generate` (smart mode) and `sync` (no-declarative-files bootstrap) so
 * both offer the same local / linked / custom choice and local-reset prompt.
 */
export const legacyResolveSmartTargetUrl = Effect.fnUntraced(function* (
  flags: LegacySmartTargetFlags,
  local: LegacyLocalConn,
  hasMigrations: boolean,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  linkedRef: Option.Option<string>,
) {
  if (!hasMigrations) {
    // No migrations → generate from local. Go runs ensureLocalDatabaseStarted first
    // (db_schema_declarative.go:291), starting a stopped stack.
    yield* (yield* LegacyDeclarativeSeam).ensureLocalDatabaseStarted();
    return legacyLocalUrl(local);
  }

  const output = yield* Output;
  const yes = yield* LegacyYesFlag;
  const networkId = yield* LegacyNetworkIdFlag;
  // Insert "Linked project" between local and custom (Go's choice order) when the
  // workdir is linked with a valid ref. Go gates this on `LoadProjectRef`, which
  // validates the ref (`project_ref.go:75`), so an invalid on-disk ref hides the
  // choice rather than showing it and failing later.
  const showLinked = Option.isSome(linkedRef) && PROJECT_REF_PATTERN.test(linkedRef.value);
  const choice = yield* output.promptSelect("Generate declarative schema from:", [
    { value: "local", label: "Local database", hint: "generate from local Postgres" },
    ...(showLinked && Option.isSome(linkedRef)
      ? [
          {
            value: "linked",
            label: "Linked project",
            hint: `generate from remote linked project (${linkedRef.value})`,
          },
        ]
      : []),
    { value: "custom", label: "Custom database URL", hint: "enter a connection string" },
  ]);

  if (choice === "linked") {
    // Same path as an explicit `--linked` (Go calls `NewDbConfigWithPassword`):
    // login-role mint + pooler fallback, then `ToPostgresURL`.
    return yield* legacyResolveRemoteUrl({ ...flags, linked: Option.some(true) });
  }

  if (choice === "custom") {
    const dbURL = yield* output.promptText("Enter database URL: ");
    if (dbURL.trim().length === 0) {
      return yield* Effect.fail(
        new LegacyDeclarativeInvalidDbUrlError({ message: "database URL cannot be empty" }),
      );
    }
    // Go parses the entry with pgconn.ParseConfig then feeds pg-delta a normalized
    // ToPostgresURL (`apps/cli-go/cmd/db_schema_declarative.go:283-287`). Layer the
    // project env under the shell env like the --db-url path so libpq PG* fallbacks
    // resolve, and reject malformed input with Go's "failed to parse connection
    // string" error (password redacted, CWE-209).
    const projectEnv = yield* legacyLoadProjectEnv(fs, path, workdir);
    const conn = parseLegacyConnectionString(
      dbURL,
      (name) => process.env[name] ?? projectEnv[name],
    );
    if (conn === undefined) {
      return yield* Effect.fail(
        new LegacyDeclarativeInvalidDbUrlError({
          message: `failed to parse connection string: ${redactLegacyConnectionString(dbURL)}`,
        }),
      );
    }
    return legacyToPostgresURL(conn);
  }

  // "Local database" choice: Go runs ensureLocalDatabaseStarted before the reset
  // prompt (db_schema_declarative.go:249), starting a stopped stack.
  yield* (yield* LegacyDeclarativeSeam).ensureLocalDatabaseStarted();

  let shouldReset = flags.reset;
  if (!shouldReset) {
    // Go asks via Console.PromptYesNo (db_schema_declarative.go:257, default false),
    // which auto-returns true under the global --yes flag (console.go:74-77), so
    // `--yes` auto-resets here instead of prompting.
    shouldReset = yes
      ? true
      : yield* output.promptConfirm(
          "Reset local database to match migrations first? (local data will be lost)",
          { defaultValue: false },
        );
  }
  if (shouldReset) {
    // Go runs reset in-process and returns the error (`cmd/db_schema_declarative.go:262-267`).
    // Use the non-exiting seam (not LegacyGoProxy.exec, which process.exits on a
    // non-zero child and would skip the handler's telemetry flush / error handling),
    // and propagate a failure on a non-zero reset exit.
    const seam = yield* LegacyDeclarativeSeam;
    // Forward --network-id: Go's in-process reset.Run honors the root viper
    // network-id (`apps/cli-go/internal/utils/docker.go:267-271`), so the
    // seam-spawned reset must carry it to stay on a custom Docker network.
    const code = yield* seam.execInherit([
      "db",
      "reset",
      "--local",
      ...(Option.isSome(networkId) ? ["--network-id", networkId.value] : []),
    ]);
    if (code !== 0) {
      return yield* Effect.fail(
        new LegacyDeclarativeApplyError({ message: `database reset failed (exit ${code})` }),
      );
    }
  }
  return legacyLocalUrl(local);
});
