import { Effect, type FileSystem, Option, type Path } from "effect";

import {
  DnsResolverFlag,
  resolveYesWithProjectEnv,
} from "../../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../../command-internal/prompt-yes-no.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { resetLocalDatabase } from "../../../../command-internal/db-bootstrap/reset-local-database.ts";
import { PROJECT_REF_PATTERN } from "../../../../config/project-ref.service.ts";
import { DbConfigResolver } from "../../../../command-internal/db-config.service.ts";
import { loadProjectEnv } from "../../../../command-internal/db-config.toml-read.ts";
import {
  parseConnectionString,
  redactConnectionString,
} from "../../../../command-internal/db-config.parse.ts";
import { getHostname } from "../../../../command-internal/hostname.ts";
import { toPostgresURL } from "../../../../command-internal/postgres-url.ts";
import type { PgDeltaDatabaseEndpoint } from "../../shared/pgdelta-engine.service.ts";
import {
  DeclarativeApplyError,
  DeclarativeInvalidDbUrlError,
  readErrorSuggestion,
} from "./declarative.errors.ts";
import type { DeclarativeShadowDbError } from "../../shared/pgdelta.errors.ts";
import { DeclarativeSeam } from "../../shared/pgdelta.seam.service.ts";

/**
 * The local connection bits the smart-target resolver needs (Go reads these from
 * the merged config's `[db]`).
 */
export interface LocalConn {
  readonly port: number;
  readonly password: string;
}

/**
 * The flag surface the smart-target resolver reads. Both `generate` (passing its
 * full flags) and `sync` (constructing a target-less value for its bootstrap)
 * satisfy this, mirroring Go passing the same `cmd` into `runDeclarativeGenerate`.
 */
export interface SmartTargetFlags {
  readonly dbUrl: Option.Option<string>;
  // Presence-modelled (Go's `flag.Changed`), like `--db-url`. The resolver only
  // reads `dbUrl` to pick db-url vs linked, so this is carried for type-compat.
  readonly linked: Option.Option<boolean>;
  readonly password: Option.Option<string>;
  readonly reset: boolean;
}

const localConnection = (local: LocalConn) => ({
  // Go derives the local host from `utils.Config.Hostname` (`GetHostname()`:
  // SUPABASE_SERVICES_HOSTNAME → tcp DOCKER_HOST → 127.0.0.1), not a hardcoded
  // loopback (`apps/cli-go/internal/utils/misc.go:298-312`).
  host: getHostname(),
  port: local.port,
  user: "postgres",
  password: local.password,
  database: "postgres",
});

export const localEndpoint = (
  local: LocalConn,
  dnsResolver: "native" | "https",
): PgDeltaDatabaseEndpoint => {
  const connection = localConnection(local);
  return {
    kind: "database",
    ref: toPostgresURL(connection),
    connection,
    connectOptions: { isLocal: true, dnsResolver },
  };
};

/** Resolves a remote target without discarding TLS and connection options. */
export const resolveRemoteEndpoint = Effect.fnUntraced(function* (flags: SmartTargetFlags) {
  const resolver = yield* DbConfigResolver;
  const dnsResolver = yield* DnsResolverFlag;
  const resolved = yield* resolver.resolve({
    dbUrl: flags.dbUrl,
    connType: Option.isSome(flags.dbUrl) ? "db-url" : "linked",
    dnsResolver,
    password: flags.password,
  });
  return {
    kind: "database",
    ref: toPostgresURL(resolved.conn),
    connection: resolved.conn,
    connectOptions: { isLocal: resolved.isLocal, dnsResolver },
  } satisfies PgDeltaDatabaseEndpoint;
});

/**
 * Smart-mode (no explicit target) interactive target resolution — Go's
 * `runDeclarativeGenerate` smart branch (`apps/cli-go/cmd/db_schema_declarative.go:198-298`,
 * deleted in CLI-1970; last present at commit 7b469f5b3).
 * Shared by `generate` (smart mode) and `sync` (no-declarative-files bootstrap) so
 * both offer the same local / linked / custom choice and local-reset prompt.
 */
export const resolveSmartTargetEndpoint = Effect.fnUntraced(function* (
  flags: SmartTargetFlags,
  local: LocalConn,
  hasMigrations: boolean,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  linkedRef: Option.Option<string>,
  beforeLocalTarget: Effect.Effect<void, DeclarativeShadowDbError> = Effect.void,
) {
  if (!hasMigrations) {
    // No migrations → generate from local. Go runs ensureLocalDatabaseStarted first
    // (db_schema_declarative.go:291), starting a stopped stack.
    yield* beforeLocalTarget;
    yield* (yield* DeclarativeSeam).ensureLocalDatabaseStarted();
    return localEndpoint(local, yield* DnsResolverFlag);
  }

  const output = yield* Output;
  // Go's prompts below read `viper.GetBool("YES")` after `loadNestedEnv`
  // (`pkg/config/config.go:789`), so `SUPABASE_YES` — from the shell env or the
  // project `.env` — must auto-confirm too, not just the flag (CLI-1974).
  const projectEnv = yield* loadProjectEnv(fs, path, workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);
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
    return yield* resolveRemoteEndpoint({ ...flags, linked: Option.some(true) });
  }

  if (choice === "custom") {
    const dbURL = yield* output.promptText("Enter database URL: ");
    if (dbURL.trim().length === 0) {
      return yield* Effect.fail(
        new DeclarativeInvalidDbUrlError({ message: "database URL cannot be empty" }),
      );
    }
    // Go parses the entry with pgconn.ParseConfig then feeds pg-delta a normalized
    // ToPostgresURL (`apps/cli-go/cmd/db_schema_declarative.go:283-287`, deleted
    // in CLI-1970; last present at commit 7b469f5b3). Layer the
    // project env (loaded once above) under the shell env like the --db-url path so
    // libpq PG* fallbacks resolve, and reject malformed input with Go's "failed to
    // parse connection string" error (password redacted, CWE-209).
    const conn = parseConnectionString(dbURL, (name) => process.env[name] ?? projectEnv[name]);
    if (conn === undefined) {
      return yield* Effect.fail(
        new DeclarativeInvalidDbUrlError({
          message: `failed to parse connection string: ${redactConnectionString(dbURL)}`,
        }),
      );
    }
    return {
      kind: "database",
      ref: toPostgresURL(conn),
      connection: conn,
      connectOptions: { isLocal: false, dnsResolver: yield* DnsResolverFlag },
    } satisfies PgDeltaDatabaseEndpoint;
  }

  // "Local database" choice: Go runs ensureLocalDatabaseStarted before the reset
  // prompt (db_schema_declarative.go:249), starting a stopped stack.
  yield* beforeLocalTarget;
  yield* (yield* DeclarativeSeam).ensureLocalDatabaseStarted();

  let shouldReset = flags.reset;
  if (!shouldReset) {
    // Go asks via Console.PromptYesNo (db_schema_declarative.go:320-322, default
    // false): --yes/SUPABASE_YES auto-resets WITH the `<label> [y/N] y` stderr
    // echo (console.go:70-72) — routed through `promptYesNo` so the echo
    // is not skipped (CLI-1974).
    shouldReset = yield* promptYesNo(
      output,
      yes,
      "Reset local database to match migrations first? (local data will be lost)",
      false,
    );
  }
  if (shouldReset) {
    // Go runs reset in-process and returns the error (`cmd/db_schema_declarative.go:262-267`).
    // `resetLocalDatabase` now runs the same way — in-process, sharing this
    // command's own context — rather than shelling out to a second `supabase-go` child
    // (CLI-2062): it resolves `NetworkIdFlag` itself, so no argv-forwarding is
    // needed to stay on a custom Docker network, and a real failure propagates through
    // the effect's own failure channel instead of a synthesized exit code.
    yield* resetLocalDatabase().pipe(
      Effect.mapError(
        (error) =>
          new DeclarativeApplyError({
            message: `database reset failed: ${error.message}`,
            suggestion: readErrorSuggestion(error),
          }),
      ),
    );
  }
  return localEndpoint(local, yield* DnsResolverFlag);
});
