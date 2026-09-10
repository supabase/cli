import { Effect, type FileSystem, Option, type Path } from "effect";

import {
  DnsResolverFlag,
  resolveYesWithProjectEnv,
} from "../../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../../command-internal/prompt-yes-no.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { resetLocalDatabase } from "../../../../command-internal/db-bootstrap/reset-local-database.ts";
import { PROJECT_REF_PATTERN } from "../../../../config/project-ref.service.ts";
import { currentStackBackend } from "../../../experimental/stack/stack-backend.ts";
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

/** The local connection bits the smart-target resolver needs. */
export interface LocalConn {
  readonly port: number;
  readonly password: string;
}

/**
 * The flag surface the smart-target resolver reads. Both `generate` (passing its full flags) and
 * `sync` (constructing a target-less value for its bootstrap) satisfy this.
 */
export interface SmartTargetFlags {
  readonly dbUrl: Option.Option<string>;
  // Presence-modelled like `--db-url`. The resolver only reads `dbUrl` to pick db-url vs linked,
  // so this is carried for type-compat.
  readonly linked: Option.Option<boolean>;
  readonly password: Option.Option<string>;
  readonly reset: boolean;
}

const localConnection = (local: LocalConn) => ({
  // Host resolution order: SUPABASE_SERVICES_HOSTNAME → tcp DOCKER_HOST → 127.0.0.1, not a
  // hardcoded loopback.
  host: getHostname(),
  port: local.port,
  user: "postgres",
  password: local.password,
  database: "postgres",
});

const localEndpoint = (
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

/** Local target URL: stack credentials when the stack backend is on, else config.toml `[db]`. */
export const resolveLocalTargetEndpoint = Effect.fnUntraced(function* (
  local: LocalConn,
  dnsResolver: "native" | "https",
) {
  const backend = yield* currentStackBackend;
  if (backend.kind !== "stack") return localEndpoint(local, dnsResolver);
  const resolver = yield* DbConfigResolver;
  const resolved = yield* resolver.resolve({
    dbUrl: Option.none(),
    connType: "local",
    dnsResolver,
  });
  return {
    kind: "database",
    ref: toPostgresURL(resolved.conn),
    connection: resolved.conn,
    connectOptions: { isLocal: true, dnsResolver },
  } satisfies PgDeltaDatabaseEndpoint;
});

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
 * Smart-mode (no explicit target) interactive target resolution, shared by `generate` (smart
 * mode) and `sync` (no-declarative-files bootstrap) so both offer the same local/linked/custom
 * choice and local-reset prompt.
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
    // No migrations: generate from local, starting a stopped stack first.
    yield* beforeLocalTarget;
    yield* (yield* DeclarativeSeam).ensureLocalDatabaseStarted();
    return yield* resolveLocalTargetEndpoint(local, yield* DnsResolverFlag);
  }

  const output = yield* Output;
  // `SUPABASE_YES` — from the shell env or the project `.env` — must auto-confirm the prompts
  // below too, not just the `--yes` flag.
  const projectEnv = yield* loadProjectEnv(fs, path, workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);
  // Inserts "Linked project" between local and custom when the workdir is linked with a valid
  // ref; an invalid on-disk ref hides the choice rather than showing it and failing later.
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
    // Same path as an explicit `--linked`: login-role mint + pooler fallback, then the resolved URL.
    return yield* resolveRemoteEndpoint({ ...flags, linked: Option.some(true) });
  }

  if (choice === "custom") {
    const dbURL = yield* output.promptText("Enter database URL: ");
    if (dbURL.trim().length === 0) {
      return yield* Effect.fail(
        new DeclarativeInvalidDbUrlError({ message: "database URL cannot be empty" }),
      );
    }
    // Layers the project env (loaded once above) under the shell env like the --db-url path so
    // libpq PG* fallbacks resolve; malformed input fails with a redacted connection string
    // (CWE-209).
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

  // "Local database" choice: starts a stopped stack before the reset prompt.
  yield* beforeLocalTarget;
  yield* (yield* DeclarativeSeam).ensureLocalDatabaseStarted();

  let shouldReset = flags.reset;
  if (!shouldReset) {
    // `--yes`/`SUPABASE_YES` auto-resets, but still echoes the `<label> [y/N] y` stderr line via
    // `promptYesNo` rather than skipping it.
    shouldReset = yield* promptYesNo(
      output,
      yes,
      "Reset local database to match migrations first? (local data will be lost)",
      false,
    );
  }
  if (shouldReset) {
    // `resetLocalDatabase` runs in-process, sharing this command's own context: it resolves
    // `NetworkIdFlag` itself, so no argv-forwarding is needed to stay on a custom Docker network,
    // and a real failure propagates through the effect's own failure channel.
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
  return yield* resolveLocalTargetEndpoint(local, yield* DnsResolverFlag);
});
