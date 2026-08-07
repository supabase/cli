import { Effect, type FileSystem, Option, type Path } from "effect";

import {
  LegacyDnsResolverFlag,
  legacyResolveYesWithProjectEnv,
} from "../../../../../shared/legacy/global-flags.ts";
import { legacyPromptYesNo } from "../../../../../shared/legacy/legacy-prompt-yes-no.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { legacyResetLocalDatabase } from "../../../../shared/db-bootstrap/reset-local-database.ts";
import { PROJECT_REF_PATTERN } from "../../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../../shared/legacy-db-config.service.ts";
import { legacyLoadProjectEnv } from "../../../../shared/legacy-db-config.toml-read.ts";
import {
  parseLegacyConnectionString,
  redactLegacyConnectionString,
} from "../../../../shared/legacy-db-config.parse.ts";
import { legacyGetHostname } from "../../../../shared/legacy-hostname.ts";
import { legacyToPostgresURL } from "../../../../shared/legacy-postgres-url.ts";
import type { LegacyPgDeltaDatabaseEndpoint } from "../../shared/legacy-pgdelta-engine.service.ts";
import {
  LegacyDeclarativeApplyError,
  LegacyDeclarativeInvalidDbUrlError,
} from "./declarative.errors.ts";
import type { LegacyDeclarativeShadowDbError } from "../../shared/legacy-pgdelta.errors.ts";
import { LegacyDeclarativeSeam } from "../../shared/legacy-pgdelta.seam.service.ts";

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

const legacyLocalConnection = (local: LegacyLocalConn) => ({
  // Go derives the local host from `utils.Config.Hostname` (`GetHostname()`:
  // SUPABASE_SERVICES_HOSTNAME → tcp DOCKER_HOST → 127.0.0.1), not a hardcoded
  // loopback (`apps/cli-go/internal/utils/misc.go:298-312`).
  host: legacyGetHostname(),
  port: local.port,
  user: "postgres",
  password: local.password,
  database: "postgres",
});

export const legacyLocalEndpoint = (
  local: LegacyLocalConn,
  dnsResolver: "native" | "https",
): LegacyPgDeltaDatabaseEndpoint => {
  const connection = legacyLocalConnection(local);
  return {
    kind: "database",
    ref: legacyToPostgresURL(connection),
    connection,
    connectOptions: { isLocal: true, dnsResolver },
  };
};

/** Resolves a remote target without discarding TLS and connection options. */
export const legacyResolveRemoteEndpoint = Effect.fnUntraced(function* (
  flags: LegacySmartTargetFlags,
) {
  const resolver = yield* LegacyDbConfigResolver;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const resolved = yield* resolver.resolve({
    dbUrl: flags.dbUrl,
    connType: Option.isSome(flags.dbUrl) ? "db-url" : "linked",
    dnsResolver,
    password: flags.password,
  });
  return {
    kind: "database",
    ref: legacyToPostgresURL(resolved.conn),
    connection: resolved.conn,
    connectOptions: { isLocal: resolved.isLocal, dnsResolver },
  } satisfies LegacyPgDeltaDatabaseEndpoint;
});

/**
 * Smart-mode (no explicit target) interactive target resolution — Go's
 * `runDeclarativeGenerate` smart branch (`apps/cli-go/cmd/db_schema_declarative.go:198-298`).
 * Shared by `generate` (smart mode) and `sync` (no-declarative-files bootstrap) so
 * both offer the same local / linked / custom choice and local-reset prompt.
 */
export const legacyResolveSmartTargetEndpoint = Effect.fnUntraced(function* (
  flags: LegacySmartTargetFlags,
  local: LegacyLocalConn,
  hasMigrations: boolean,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  linkedRef: Option.Option<string>,
  beforeLocalTarget: Effect.Effect<void, LegacyDeclarativeShadowDbError> = Effect.void,
) {
  if (!hasMigrations) {
    // No migrations → generate from local. Go runs ensureLocalDatabaseStarted first
    // (db_schema_declarative.go:291), starting a stopped stack.
    yield* beforeLocalTarget;
    yield* (yield* LegacyDeclarativeSeam).ensureLocalDatabaseStarted();
    return legacyLocalEndpoint(local, yield* LegacyDnsResolverFlag);
  }

  const output = yield* Output;
  // Go's prompts below read `viper.GetBool("YES")` after `loadNestedEnv`
  // (`pkg/config/config.go:789`), so `SUPABASE_YES` — from the shell env or the
  // project `.env` — must auto-confirm too, not just the flag (CLI-1974).
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, workdir);
  const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);
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
    return yield* legacyResolveRemoteEndpoint({ ...flags, linked: Option.some(true) });
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
    // project env (loaded once above) under the shell env like the --db-url path so
    // libpq PG* fallbacks resolve, and reject malformed input with Go's "failed to
    // parse connection string" error (password redacted, CWE-209).
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
    return {
      kind: "database",
      ref: legacyToPostgresURL(conn),
      connection: conn,
      connectOptions: { isLocal: false, dnsResolver: yield* LegacyDnsResolverFlag },
    } satisfies LegacyPgDeltaDatabaseEndpoint;
  }

  // "Local database" choice: Go runs ensureLocalDatabaseStarted before the reset
  // prompt (db_schema_declarative.go:249), starting a stopped stack.
  yield* beforeLocalTarget;
  yield* (yield* LegacyDeclarativeSeam).ensureLocalDatabaseStarted();

  let shouldReset = flags.reset;
  if (!shouldReset) {
    // Go asks via Console.PromptYesNo (db_schema_declarative.go:320-322, default
    // false): --yes/SUPABASE_YES auto-resets WITH the `<label> [y/N] y` stderr
    // echo (console.go:70-72) — routed through `legacyPromptYesNo` so the echo
    // is not skipped (CLI-1974).
    shouldReset = yield* legacyPromptYesNo(
      output,
      yes,
      "Reset local database to match migrations first? (local data will be lost)",
      false,
    );
  }
  if (shouldReset) {
    // Go runs reset in-process and returns the error (`cmd/db_schema_declarative.go:262-267`).
    // `legacyResetLocalDatabase` now runs the same way — in-process, sharing this
    // command's own context — rather than shelling out to a second `supabase-go` child
    // (CLI-2062): it resolves `LegacyNetworkIdFlag` itself, so no argv-forwarding is
    // needed to stay on a custom Docker network, and a real failure propagates through
    // the effect's own failure channel instead of a synthesized exit code.
    yield* legacyResetLocalDatabase().pipe(
      Effect.mapError(
        (error) =>
          new LegacyDeclarativeApplyError({ message: `database reset failed: ${error.message}` }),
      ),
    );
  }
  return legacyLocalEndpoint(local, yield* LegacyDnsResolverFlag);
});
