import type { Option } from "effect";
import type { LegacyPgConnInput } from "./legacy-db-connection.service.ts";
import type { LegacyDbConnType } from "./legacy-db-target-flags.ts";

/**
 * The connection-resolution flags shared by `db lint`, `db advisors`, `test db`
 * (and later `db reset` / `db dump`).
 *
 * `connType` encodes which selector flag was explicitly set by the user, derived
 * from raw argv via `resolveLegacyDbTargetFlags` (Changed-first, matching Go's
 * `ParseDatabaseConfig` at `apps/cli-go/internal/utils/flags/db_url.go:46-63`):
 *   - "db-url"  → `--db-url` was changed (read `dbUrl.value`)
 *   - "linked"  → `--linked` was changed (Management API path)
 *   - "local"   → `--local` was changed (explicit local path)
 *   - undefined → no selector was changed; resolver defaults to local
 *
 * `--db-url` / `--linked` / `--local` are mutually exclusive
 * (`apps/cli-go/cmd/db.go:482-485`).  `dnsResolver` carries the global
 * `--dns-resolver` value (Go's `utils.DNSResolver.Value`), used when the
 * resolver opens its own remote connection (the linked pooler temp-role probe);
 * the handler passes the same value to its primary `connect`.
 */
export interface LegacyDbConfigFlags {
  readonly dbUrl: Option.Option<string>;
  readonly connType: LegacyDbConnType | undefined;
  readonly dnsResolver: "native" | "https";
}

/**
 * A resolved Postgres connection plus whether it points at the local stack
 * (`utils.IsLocalDatabase`). `isLocal` decides the pg_prove docker network/host
 * rewrite in the `test db` handler, so it is computed once here.
 */
export interface LegacyResolvedDbConfig {
  readonly conn: LegacyPgConnInput;
  readonly isLocal: boolean;
}
