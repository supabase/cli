import type { Option } from "effect";
import type { PgConnInput } from "./db-connection.service.ts";
import type { DbConnType } from "./db-target-flags.ts";

/**
 * The connection-resolution flags shared by `db lint`, `db advisors`, and `test db`.
 *
 * `connType` records which selector flag the user explicitly set, derived from raw argv via
 * `resolveDbTargetFlags`:
 * - "db-url" → `--db-url` was set (read `dbUrl.value`)
 * - "linked" → `--linked` was set (Management API path)
 * - "local" → `--local` was set (explicit local path)
 * - undefined → no selector was set; resolver defaults to local
 *
 * `--db-url` / `--linked` / `--local` are mutually exclusive. `dnsResolver` carries the global
 * `--dns-resolver` value, used when the resolver opens its own remote connection (the linked
 * pooler temp-role probe); the handler passes the same value to its primary `connect`.
 */
export interface DbConfigFlags {
  readonly dbUrl: Option.Option<string>;
  readonly connType: DbConnType | undefined;
  readonly dnsResolver: "native" | "https";
  /**
   * Whether config resolution should decrypt and materialize `[db.vault]` values.
   * Defaults to true; `db push --skip-vault` is the only caller that disables it.
   */
  readonly resolveVaultSecrets?: boolean;
  /**
   * The `--password`/`-p` flag value. When `Some`, it takes precedence over the
   * `SUPABASE_DB_PASSWORD` env var on the linked path. Commands without a `--password` flag
   * (e.g. `test db`) omit it, and the resolver falls back to env only.
   */
  readonly password?: Option.Option<string>;
  /**
   * Optional explicit linked project ref override, letting e.g. `gen types --project-id <ref>`
   * reuse the linked resolver's temp-role and pooler fallback without the workdir being linked.
   * Shares only `SUPABASE_PROJECT_ID`'s ref-resolution precedence (flag > env >
   * `.temp/project-ref`) — it never drives the local container id or pg-delta project id the way
   * that env var does. `None` preserves the normal `--linked` fallback.
   */
  readonly linkedProjectRef?: Option.Option<string>;
  /**
   * Marks `linkedProjectRef` as an ad-hoc remote target (e.g. `gen types --project-id <ref>`)
   * rather than the current linked workdir, so the resolver must not reuse workdir-scoped
   * credentials or cached state for it: it ignores the ambient `SUPABASE_DB_PASSWORD` and skips
   * the saved `.temp/pooler-url`, fetching pooler config from the Management API instead. Absent
   * for the normal `--linked` path, which may reuse both.
   */
  readonly adHocProjectRef?: boolean;
}

/**
 * A resolved Postgres connection plus whether it points at the local stack. `isLocal` decides
 * the pg_prove docker network/host rewrite in the `test db` handler, so it is computed once here.
 */
export interface ResolvedDbConfig {
  readonly conn: PgConnInput;
  readonly isLocal: boolean;
  /**
   * The resolved linked project ref (`--linked` path only; `None` for `--local` / `--db-url`).
   * Lets the caller re-read config with the ref applied so a matching `[remotes.<ref>]` block can
   * override fields like `db.major_version` for the container image.
   */
  readonly ref?: Option.Option<string>;
}
