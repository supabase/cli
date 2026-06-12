import type { Option } from "effect";
import type { LegacyPgConnInput } from "./legacy-db-connection.service.ts";

/**
 * The connection-resolution flags shared by `test db` (and later `db reset` /
 * `db dump`). `--db-url` / `--linked` / `--local` are the mutually exclusive
 * connection selectors (`apps/cli-go/cmd/db.go:482-485`); `local` defaults to
 * true in Go, so absence of all three resolves to local. `dnsResolver` carries
 * the global `--dns-resolver` value (Go's `utils.DNSResolver.Value`), used when
 * the resolver opens its own remote connection (the linked pooler temp-role
 * probe); the handler passes the same value to its primary `connect`.
 */
export interface LegacyDbConfigFlags {
  readonly dbUrl: Option.Option<string>;
  readonly linked: boolean;
  readonly local: boolean;
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
