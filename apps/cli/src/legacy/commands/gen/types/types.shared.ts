import { Effect } from "effect";

import type { LegacyPgConnInput } from "../../../shared/legacy-db-connection.service.ts";
import { legacyParseGoDuration } from "../../../shared/legacy-go-duration.ts";
import { LegacyInvalidGenTypesDurationError } from "./types.errors.ts";

// The local Docker container id is hoisted to `legacy/shared` so the declarative
// seam can derive the same `supabase_db_<id>` name when checking the local stack.
export { localDbContainerId } from "../../../shared/legacy-docker-ids.ts";

export function defaultSchemas(extraSchemas: ReadonlyArray<string> = []) {
  return [...new Set(["public", ...extraSchemas])];
}

function invalidQueryTimeout(raw: string, detail?: string) {
  return new LegacyInvalidGenTypesDurationError({
    message:
      detail === undefined
        ? `invalid duration ${JSON.stringify(raw)}`
        : `invalid duration ${JSON.stringify(raw)}: ${detail}`,
  });
}

export function parseQueryTimeoutSeconds(
  raw: string,
): Effect.Effect<number, LegacyInvalidGenTypesDurationError> {
  return Effect.try({
    try: () => legacyParseGoDuration(raw),
    catch: () => invalidQueryTimeout(raw),
  }).pipe(
    Effect.flatMap((nanos) => {
      if (nanos < 0) {
        return Effect.fail(invalidQueryTimeout(raw));
      }
      // Whole-second `statement_timeout` / client bound. `0` is the disable
      // sentinel — a positive duration that rounds into it would silently
      // drop the user's requested cap.
      const seconds = Math.round(nanos / 1_000_000_000);
      if (seconds === 0 && nanos !== 0) {
        return Effect.fail(invalidQueryTimeout(raw, "use 0 to disable, or at least 500ms"));
      }
      return Effect.succeed(seconds);
    }),
  );
}

export function localDbPassword() {
  return process.env["SUPABASE_DB_PASSWORD"] ?? "postgres";
}

/**
 * `--query-timeout` parity with the retired pg-meta envs: the flag becomes
 * session `statement_timeout` (milliseconds; `0` disables) and, when the DSN
 * has no `connect_timeout` and the flag is positive, the connect timeout.
 * Zero must not become `connectTimeoutSeconds: 0` — the driver treats that as
 * an immediate `Effect.timeout` rather than "disabled".
 */
export function applyQueryTimeouts(
  conn: LegacyPgConnInput,
  queryTimeoutSeconds: number,
): LegacyPgConnInput {
  const runtimeParams = {
    ...conn.runtimeParams,
    statement_timeout: `${queryTimeoutSeconds * 1000}`,
  };
  if (queryTimeoutSeconds > 0 && conn.connectTimeoutSeconds === undefined) {
    return { ...conn, connectTimeoutSeconds: queryTimeoutSeconds, runtimeParams };
  }
  return { ...conn, runtimeParams };
}

/**
 * When the DSN omitted `sslmode`, the SSLRequest probe decides: no TLS →
 * `disable`; TLS → `require` plus the embedded CA path so the driver promotes
 * to `verify-ca` (the retired `PG_META_DB_SSL_ROOT_CERT` injection).
 */
export function applyProbedSslMode(
  conn: LegacyPgConnInput,
  useTls: boolean,
  sslrootcert?: string,
): LegacyPgConnInput {
  if (conn.sslmode !== undefined) return conn;
  if (!useTls) return { ...conn, sslmode: "disable" };
  return {
    ...conn,
    sslmode: "require",
    ...(sslrootcert !== undefined && sslrootcert.length > 0 ? { sslrootcert } : {}),
  };
}

/**
 * `--network-id` cannot attach the in-process generator to a Docker network.
 * Point at a host-reachable DSN, or run the CLI inside that network.
 */
export function legacyGenTypesNetworkIdUnusedWarning(networkId: string): string {
  const network = networkId.length > 0 ? networkId : "<network-id>";
  return (
    "--network-id is unused: gen types no longer runs inside a container and cannot join a Docker network.\n" +
    "To reach a hostname that exists only on that network:\n" +
    `  docker run --rm --network ${network} node:lts npx --yes supabase gen types --db-url <url>`
  );
}
