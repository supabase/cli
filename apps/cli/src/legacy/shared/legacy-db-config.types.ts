import type { Option } from "effect";
import type { LegacyPgConnInput } from "./legacy-db-connection.service.ts";

/**
 * The mutually exclusive connection-selection flags shared by `test db` (and
 * later `db reset` / `db dump`). Mirrors `--db-url` / `--linked` / `--local`
 * (`apps/cli-go/cmd/db.go:482-485`). `local` defaults to true in Go; absence of
 * all three resolves to local.
 */
export interface LegacyDbConfigFlags {
  readonly dbUrl: Option.Option<string>;
  readonly linked: boolean;
  readonly local: boolean;
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
