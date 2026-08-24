// Auto-expose drift check shared by `db diff --linked` and linked `db pull`.
//
// The platform still provisions new projects with the default Data API privileges
// granted (`auto_expose_new_tables` effectively ON), while the CLI treats an unset
// `api.auto_expose_new_tables` as OFF since the 2026-05-30 default flip (see
// `legacy-db-config.toml-read.ts`) and revokes those privileges on every local and
// shadow database it provisions. The mismatch surfaces as default-privilege
// statements in every shadow diff against the linked project. The Management API
// exposes no field for this state, so the only source of truth is the remote
// database's own `pg_default_acl` — probed here over the already-resolved remote
// connection.
//
// The check is strictly best-effort: a connect or query failure (IPv6-only
// networks without the pooler, a restricted role, a paused project racing the
// resolver) silently skips the warning rather than failing a diff/pull that would
// otherwise succeed.

import { Effect, Option } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { LEGACY_START_REVOKE_API_PRIVILEGES_SQL } from "../../../shared/db-bootstrap/db-setup.ts";
import {
  LegacyDbConnection,
  type LegacyDbConnectOptions,
  type LegacyDbSession,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";

/**
 * The exact inverse of {@link LEGACY_START_REVOKE_API_PRIVILEGES_SQL} — the
 * migration suggested when the local config enables auto-expose but the linked
 * project has it revoked. Deliberately grants the revoke's own verb list rather
 * than the initial schema's `GRANT ALL`, so the suggested migration restores
 * exactly what the CLI itself removes and nothing more.
 */
export const LEGACY_GRANT_DEFAULT_API_PRIVILEGES_SQL = `
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;
`;

/**
 * Reports whether new tables created by `postgres` in `public` are auto-exposed
 * through the Data API roles: a default-ACL entry granting table SELECT to any of
 * `anon`/`authenticated`/`service_role`. Table SELECT alone is the discriminator —
 * it is the first privilege the revoke removes and the one that makes a new table
 * reachable through the Data API; probing every object type would only blur the
 * boolean on hand-modified ACLs.
 */
const LEGACY_AUTO_EXPOSE_PROBE_SQL = `select exists (
  select 1
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace
  join pg_roles r on r.oid = d.defaclrole
  cross join lateral aclexplode(d.defaclacl) acl
  where r.rolname = 'postgres'
    and n.nspname = 'public'
    and d.defaclobjtype = 'r'
    and acl.privilege_type = 'SELECT'
    and acl.grantee in (
      select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role')
    )
) as auto_expose`;

/**
 * Extracts the probe's boolean. Lenient by design: an unexpected shape (no rows,
 * a driver returning `"t"`/`"f"` text) resolves to `None`, which skips the
 * warning — a wrong warning is worse than a missing one.
 */
export function legacyParseAutoExposeProbeRows(
  rows: ReadonlyArray<Record<string, unknown>>,
): Option.Option<boolean> {
  const value = rows[0]?.["auto_expose"];
  if (typeof value === "boolean") return Option.some(value);
  if (value === "t" || value === "true") return Option.some(true);
  if (value === "f" || value === "false") return Option.some(false);
  return Option.none();
}

/**
 * Renders the drift warning, or `undefined` when the local effective value
 * (explicit `true` — unset and `false` both mean revoke, matching
 * `legacyApplyApiPrivileges`) matches the remote state.
 *
 * Both directions offer the same two remedies the gap allows: align the local
 * config with the remote, or push a migration that aligns the remote with the
 * local config. When the remote is ON and the local config is not, the migration
 * leads: the config opt-out is deprecated (removed once the always-revoked
 * behaviour is permanent), so revoking on the remote is the durable fix.
 */
export function legacyAutoExposeDriftWarning(inputs: {
  readonly localAutoExpose: Option.Option<boolean>;
  readonly remoteAutoExpose: boolean;
}): string | undefined {
  const localAutoExpose = Option.isSome(inputs.localAutoExpose) && inputs.localAutoExpose.value;
  if (localAutoExpose === inputs.remoteAutoExpose) return undefined;
  if (inputs.remoteAutoExpose) {
    const localLabel = Option.isNone(inputs.localAutoExpose)
      ? "unset (treated as disabled) in your local config"
      : "disabled in your local config";
    return `WARNING: auto_expose_new_tables is enabled on the linked project but ${localLabel}.
New tables created by postgres in the public schema keep default Data API privileges on the remote database but not on the local or shadow database, so db diff and db pull may report unexpected default privilege changes.
To close the gap, disable it on the remote database by pushing a migration (supabase migration new disable_auto_expose_new_tables) containing:
${LEGACY_START_REVOKE_API_PRIVILEGES_SQL}Alternatively, set api.auto_expose_new_tables = true in supabase/config.toml to match the remote project (deprecated; this option is removed once the always-revoked behaviour becomes permanent).
`;
  }
  return `WARNING: auto_expose_new_tables is disabled on the linked project but enabled in your local config.
New tables created by postgres in the public schema are exposed through the Data API on the local and shadow database but not on the remote database, so db diff and db pull may report unexpected default privilege changes.
To close the gap, remove api.auto_expose_new_tables = true from supabase/config.toml, or re-enable it on the remote database by pushing a migration (supabase migration new enable_auto_expose_new_tables) containing:
${LEGACY_GRANT_DEFAULT_API_PRIVILEGES_SQL}`;
}

/**
 * Probes the remote's auto-expose state over an already-open session and prints
 * the drift warning on stderr when it mismatches the local
 * `api.auto_expose_new_tables` tri-state. Best-effort: a probe failure skips the
 * warning without failing the command.
 */
export const legacyWarnAutoExposeDrift = Effect.fnUntraced(function* (
  session: LegacyDbSession,
  localAutoExpose: Option.Option<boolean>,
) {
  const output = yield* Output;
  yield* Effect.gen(function* () {
    const rows = yield* session.query(LEGACY_AUTO_EXPOSE_PROBE_SQL);
    const remote = legacyParseAutoExposeProbeRows(rows);
    if (Option.isNone(remote)) return;
    const warning = legacyAutoExposeDriftWarning({
      localAutoExpose,
      remoteAutoExpose: remote.value,
    });
    if (warning === undefined) return;
    yield* output.raw(warning, "stderr");
  }).pipe(Effect.catchTag("LegacyDbExecError", () => Effect.void));
});

/**
 * {@link legacyWarnAutoExposeDrift} for callers without a session of their own
 * (`db diff --linked`, which hands its resolved connection straight to the diff
 * engine): dials a short-lived scoped connection just for the probe. A connect
 * failure (e.g. a direct linked host on an IPv6-only network) skips the warning —
 * the engine's own connection path owns surfacing/falling back on that failure.
 */
export const legacyWarnAutoExposeDriftOverConnection = Effect.fnUntraced(function* (
  conn: LegacyPgConnInput,
  options: LegacyDbConnectOptions,
  localAutoExpose: Option.Option<boolean>,
) {
  const connection = yield* LegacyDbConnection;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* connection.connect(conn, options);
      yield* legacyWarnAutoExposeDrift(session, localAutoExpose);
    }),
  ).pipe(Effect.catchTag("LegacyDbConnectError", () => Effect.void));
});
