import type { ProjectConfig } from "@supabase/config";

import { diff } from "./config-sync.diff.ts";
import { encodeToml, type TomlField, type TomlValue } from "./config-sync.toml.ts";
import { intToUint } from "../../../../shared/legacy-size-units.ts";

/**
 * Push-subset of Go's `db.Settings`, `db.NetworkRestrictions`,
 * `db.SslEnforcement` (`pkg/config/db.go`). Each sub-service has its own diff
 * label, GET/PUT/POST endpoint, and update body, matching
 * `pkg/config/updater.go`.
 */

// === db.settings ============================================================

type SettingsValue = { readonly [k: string]: TomlValue | undefined };

/** Settings fields whose remote value is a signed int clamped to uint (Go `cast.IntToUint`). */
const SETTINGS_UINT_KEYS: ReadonlySet<string> = new Set([
  "max_connections",
  "max_locks_per_transaction",
  "max_parallel_maintenance_workers",
  "max_parallel_workers",
  "max_parallel_workers_per_gather",
  "max_replication_slots",
  "max_wal_senders",
  "max_worker_processes",
]);

/** Ordered field descriptor mirroring the `settings` struct declaration order. */
const SETTINGS_FIELDS: ReadonlyArray<TomlField> = [
  { key: "effective_cache_size", node: { kind: "string" } },
  { key: "logical_decoding_work_mem", node: { kind: "string" } },
  { key: "maintenance_work_mem", node: { kind: "string" } },
  { key: "max_connections", node: { kind: "int" } },
  { key: "max_locks_per_transaction", node: { kind: "int" } },
  { key: "max_parallel_maintenance_workers", node: { kind: "int" } },
  { key: "max_parallel_workers", node: { kind: "int" } },
  { key: "max_parallel_workers_per_gather", node: { kind: "int" } },
  { key: "max_replication_slots", node: { kind: "int" } },
  { key: "max_slot_wal_keep_size", node: { kind: "string" } },
  { key: "max_standby_archive_delay", node: { kind: "string" } },
  { key: "max_standby_streaming_delay", node: { kind: "string" } },
  { key: "max_wal_size", node: { kind: "string" } },
  { key: "max_wal_senders", node: { kind: "int" } },
  { key: "max_worker_processes", node: { kind: "int" } },
  { key: "session_replication_role", node: { kind: "string" } },
  { key: "shared_buffers", node: { kind: "string" } },
  { key: "statement_timeout", node: { kind: "string" } },
  { key: "track_activity_query_size", node: { kind: "string" } },
  { key: "track_commit_timestamp", node: { kind: "bool" } },
  { key: "wal_keep_size", node: { kind: "string" } },
  { key: "wal_sender_timeout", node: { kind: "string" } },
  { key: "work_mem", node: { kind: "string" } },
];

const SETTINGS_KEYS: ReadonlyArray<string> = SETTINGS_FIELDS.map((f) => f.key);

/** Remote `V1GetPostgresConfig` response (subset Go reads). */
export type RemotePostgresConfig = { readonly [k: string]: string | number | boolean | undefined };

export function dbSettingsFromConfig(config: ProjectConfig): SettingsValue {
  const settings = (config.db.settings ?? {}) as SettingsValue;
  const value: Record<string, TomlValue | undefined> = {};
  for (const key of SETTINGS_KEYS) {
    value[key] = settings[key];
  }
  return value;
}

/** Port of Go `(*settings).FromRemotePostgresConfig` — overwrites every field from remote. */
function applyRemotePostgresConfig(remote: RemotePostgresConfig): SettingsValue {
  const value: Record<string, TomlValue | undefined> = {};
  for (const key of SETTINGS_KEYS) {
    const raw = remote[key];
    if (raw === undefined) {
      value[key] = undefined;
    } else if (SETTINGS_UINT_KEYS.has(key) && typeof raw === "number") {
      value[key] = intToUint(raw);
    } else {
      value[key] = raw;
    }
  }
  return value;
}

export function diffDbSettingsWithRemote(
  local: SettingsValue,
  remote: RemotePostgresConfig,
): string {
  const currentValue = encodeToml(SETTINGS_FIELDS, local);
  const remoteCompare = encodeToml(SETTINGS_FIELDS, applyRemotePostgresConfig(remote));
  return diff("remote[db.settings]", remoteCompare, "local[db.settings]", currentValue);
}

/** Body for the `V1UpdatePostgresConfig` PUT (Go `ToUpdatePostgresConfigBody`). */
export type DbSettingsUpdateBody = { [k: string]: string | number | boolean };

export function dbSettingsToUpdateBody(local: SettingsValue): DbSettingsUpdateBody {
  const body: DbSettingsUpdateBody = {};
  for (const key of SETTINGS_KEYS) {
    const v = local[key];
    if (
      v !== undefined &&
      (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    ) {
      body[key] = v;
    }
  }
  return body;
}

// === db.network_restrictions ================================================

export interface NetworkRestrictionsSubset {
  readonly enabled: boolean;
  readonly allowed_cidrs: ReadonlyArray<string>;
  readonly allowed_cidrs_v6: ReadonlyArray<string>;
}

const NETWORK_RESTRICTIONS_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enabled", node: { kind: "bool" } },
  { key: "allowed_cidrs", node: { kind: "array", elem: { kind: "string" } } },
  { key: "allowed_cidrs_v6", node: { kind: "array", elem: { kind: "string" } } },
];

/** Remote `V1GetNetworkRestrictions` response (subset Go reads). */
export interface RemoteNetworkRestrictions {
  readonly config: {
    readonly dbAllowedCidrs?: ReadonlyArray<string>;
    readonly dbAllowedCidrsV6?: ReadonlyArray<string>;
  };
}

export function networkRestrictionsFromConfig(config: ProjectConfig): NetworkRestrictionsSubset {
  const nr = config.db.network_restrictions;
  return {
    enabled: nr.enabled,
    allowed_cidrs: nr.allowed_cidrs,
    allowed_cidrs_v6: nr.allowed_cidrs_v6,
  };
}

/** Port of Go `(*networkRestrictions).FromRemoteNetworkRestrictions`. */
export function applyRemoteNetworkRestrictions(
  local: NetworkRestrictionsSubset,
  remote: RemoteNetworkRestrictions,
): NetworkRestrictionsSubset {
  if (!local.enabled) {
    return local;
  }
  return {
    ...local,
    allowed_cidrs: remote.config.dbAllowedCidrs ?? local.allowed_cidrs,
    allowed_cidrs_v6: remote.config.dbAllowedCidrsV6 ?? local.allowed_cidrs_v6,
  };
}

function networkRestrictionsToTomlValue(s: NetworkRestrictionsSubset): SettingsValue {
  return {
    enabled: s.enabled,
    allowed_cidrs: s.allowed_cidrs,
    allowed_cidrs_v6: s.allowed_cidrs_v6,
  };
}

export function diffNetworkRestrictionsWithRemote(
  local: NetworkRestrictionsSubset,
  remote: RemoteNetworkRestrictions,
): string {
  const currentValue = encodeToml(
    NETWORK_RESTRICTIONS_FIELDS,
    networkRestrictionsToTomlValue(local),
  );
  const remoteCompare = encodeToml(
    NETWORK_RESTRICTIONS_FIELDS,
    networkRestrictionsToTomlValue(applyRemoteNetworkRestrictions(local, remote)),
  );
  return diff(
    "remote[db.network_restrictions]",
    remoteCompare,
    "local[db.network_restrictions]",
    currentValue,
  );
}

/** Body for the `V1UpdateNetworkRestrictions` POST (Go `ToUpdateNetworkRestrictionsBody`). */
export interface NetworkRestrictionsUpdateBody {
  readonly dbAllowedCidrs: ReadonlyArray<string>;
  readonly dbAllowedCidrsV6: ReadonlyArray<string>;
}

export function networkRestrictionsToUpdateBody(
  local: NetworkRestrictionsSubset,
): NetworkRestrictionsUpdateBody {
  return {
    dbAllowedCidrs: local.allowed_cidrs,
    dbAllowedCidrsV6: local.allowed_cidrs_v6,
  };
}

// === db.ssl_enforcement =====================================================

export interface SslEnforcementSubset {
  readonly enabled: boolean;
}

const SSL_ENFORCEMENT_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enabled", node: { kind: "bool" } },
];

/** Remote `V1GetSslEnforcementConfig` response (subset Go reads). */
export interface RemoteSslEnforcement {
  readonly currentConfig: { readonly database: boolean };
}

/**
 * Returns the local ssl_enforcement subset, or `undefined` when not configured
 * (Go `*sslEnforcement` is nil unless `[db.ssl_enforcement]` is declared).
 *
 * `@supabase/config` decodes `ssl_enforcement` to a defaulted `{ enabled: false }`
 * whether or not the section appears, so the caller passes `present` (from
 * raw-TOML key detection) to recover Go's nil-pointer skip semantics.
 */
export function sslEnforcementFromConfig(
  config: ProjectConfig,
  present: boolean,
): SslEnforcementSubset | undefined {
  const ssl = config.db.ssl_enforcement;
  if (!present || ssl === undefined) {
    return undefined;
  }
  return { enabled: ssl.enabled };
}

/** Port of Go `(*sslEnforcement).FromRemoteSslEnforcement`. */
function applyRemoteSslEnforcement(
  _local: SslEnforcementSubset,
  remote: RemoteSslEnforcement,
): SslEnforcementSubset {
  return { enabled: remote.currentConfig.database };
}

export function diffSslEnforcementWithRemote(
  local: SslEnforcementSubset,
  remote: RemoteSslEnforcement,
): string {
  const currentValue = encodeToml(SSL_ENFORCEMENT_FIELDS, { enabled: local.enabled });
  const remoteCompare = encodeToml(SSL_ENFORCEMENT_FIELDS, {
    enabled: applyRemoteSslEnforcement(local, remote).enabled,
  });
  return diff(
    "remote[db.ssl_enforcement]",
    remoteCompare,
    "local[db.ssl_enforcement]",
    currentValue,
  );
}

/** Body for the `V1UpdateSslEnforcementConfig` PUT (Go `ToUpdateSslEnforcementBody`). */
export interface SslEnforcementUpdateBody {
  readonly requestedConfig: { readonly database: boolean };
}

export function sslEnforcementToUpdateBody(local: SslEnforcementSubset): SslEnforcementUpdateBody {
  return { requestedConfig: { database: local.enabled } };
}
