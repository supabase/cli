import { isObject } from "../config-document.ts";
import {
  formatProjectConfigParseErrorMessage,
  PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
  ProjectConfigParseError,
} from "../errors.ts";
import { authMappingRows } from "./registry-auth.ts";
import {
  clampToUint,
  expectBoolean,
  expectInteger,
  expectNumberBetween,
  expectString,
  canonicalizeCommaJoinedArray,
  splitCommaSeparated,
  type ProjectConfigMappingRow,
} from "./registry-row.ts";

/**
 * The non-auth half of the API↔`CliConfig` mapping table (CLI-2230). Rows are
 * mined from the legacy push-direction sync mappers
 * (`apps/cli/src/legacy/commands/config/push/config-sync/*.sync.ts`), which
 * already encode which API fields correspond to which config fields for
 * `config push`'s diff/apply flow — this registry repurposes that same
 * correspondence for the pull direction. Every `configPath` below was
 * verified against the live config schema (`../api.ts`, `../db.ts`,
 * `../storage.ts`) before being written; see the per-section comments for
 * fields that exist on the API side but have no config-side counterpart
 * (deliberately unmapped, not an oversight).
 */

// === api =====================================================================
// Sync precedent: config-sync/api.sync.ts:84-96 (`applyRemoteApiConfig`),
// :130-145 (`apiToUpdateBody`).

const apiDbSchemaPath = ["api", "db_schema"];
const apiExtraSearchPathPath = ["api", "db_extra_search_path"];
const apiMaxRowsPath = ["api", "max_rows"];

/**
 * Whether the remote explicitly reports the Data API as disabled:
 * api.sync.ts:84-87 (`applyRemoteApiConfig`) treats an empty remote
 * `db_schema` as "Data API disabled" and early-returns without applying
 * anything else from the section. The schemas/extra_search_path/max_rows rows
 * below gate on this so a disabled remote maps to exactly
 * `{ api: { enabled: false } }` — the other fields' remote values are
 * meaningless while the service is off, and reporting them (e.g.
 * `schemas: []`) would fabricate drift the legacy apply never saw. Only the
 * explicit `""` sentinel disables: an *absent* `db_schema` means the (sparse)
 * input didn't speak about it, so the sibling fields still map. (The legacy
 * apply conflated missing with `""` via `valOrDefault`, but it only ever saw
 * complete v1 responses, where the distinction cannot arise.)
 */
function remoteDataApiDisabled(attributes: Record<string, unknown>): boolean {
  const api = attributes["api"];
  return isObject(api) && api["db_schema"] === "";
}

/**
 * DOCUMENT-side counterpart of `clampToUint` (same convergence rule as the
 * auth `uintRow`s): the config schema accepts a negative number and the push
 * mappers send it unchanged, but every pull-direction transform below clamps
 * what the API reports — so a pushed negative projects back as `0`, and the
 * document spelling must converge on that reading. Non-numbers stay verbatim.
 */
function clampDocumentUint(value: unknown): unknown {
  return typeof value === "number" ? clampToUint(value) : value;
}

const apiSectionRows: ReadonlyArray<ProjectConfigMappingRow> = [
  {
    configPath: ["api", "schemas"],
    apiPath: apiDbSchemaPath,
    // Validation runs BEFORE the disabled gate: a malformed value alongside
    // the disabled sentinel must still throw, not vanish behind the gate
    // while its (consumed) path also disappears from unmappedApiFields.
    transform: (value, attributes) => {
      const schemas = splitCommaSeparated(expectString(value, apiDbSchemaPath));
      return remoteDataApiDisabled(attributes) ? undefined : schemas;
    },
    // Beyond the comma round-trip: an explicitly EMPTY schemas array is
    // unmanaged absence — the push only sends db_schema when the array is
    // non-empty (api.sync.ts:137-139, with "" reserved for the disable
    // path), and the pull side reads "" as the disabled sentinel, so the
    // API arm can never project `[]`; keeping it would fabricate permanent
    // drift. (extra_search_path differs: its push join is unconditional,
    // so its empty array round-trips and stays.)
    normalizeDocument: (value) => {
      const canonical = canonicalizeCommaJoinedArray(value);
      return Array.isArray(canonical) && canonical.length === 0 ? undefined : canonical;
    },
    unit: "csv → string[]",
  },
  {
    // Derived, not a distinct API field: api.sync.ts:85 treats an empty
    // remote `db_schema` as "Data API disabled" (`applyRemoteApiConfig`).
    // Shares `apiDbSchemaPath` with the row above — multiple rows may read
    // the same `apiPath` (registry-row.ts's docstring).
    configPath: ["api", "enabled"],
    apiPath: apiDbSchemaPath,
    transform: (value) => expectString(value, apiDbSchemaPath).length > 0,
  },
  {
    configPath: ["api", "extra_search_path"],
    apiPath: apiExtraSearchPathPath,
    transform: (value, attributes) => {
      const paths = splitCommaSeparated(expectString(value, apiExtraSearchPathPath));
      return remoteDataApiDisabled(attributes) ? undefined : paths;
    },
    normalizeDocument: canonicalizeCommaJoinedArray,
    unit: "csv → string[]",
  },
  {
    configPath: ["api", "max_rows"],
    apiPath: apiMaxRowsPath,
    transform: (value, attributes) => {
      const rows = clampToUint(expectInteger(value, apiMaxRowsPath));
      return remoteDataApiDisabled(attributes) ? undefined : rows;
    },
    normalizeDocument: clampDocumentUint,
  },
  // Deliberately unmapped (no config counterpart): api.db_pool,
  // api.db_pool_acquisition_timeout.
];

// === db ======================================================================

/**
 * Settings fields whose remote value is a signed int clamped to uint
 * (db.sync.ts:18 `SETTINGS_UINT_KEYS`, applied at :77-79).
 */
const DB_SETTINGS_UINT_KEYS: ReadonlyArray<string> = [
  "max_connections",
  "max_locks_per_transaction",
  "max_parallel_maintenance_workers",
  "max_parallel_workers",
  "max_parallel_workers_per_gather",
  "max_replication_slots",
  "max_wal_senders",
  "max_worker_processes",
];

/**
 * The remaining string-passthrough `db.settings` keys, verified against
 * `../db.ts:40-67`. `session_replication_role` is excluded — see
 * {@link sessionReplicationRoleRow}, below.
 */
const DB_SETTINGS_STRING_KEYS: ReadonlyArray<string> = [
  "effective_cache_size",
  "logical_decoding_work_mem",
  "maintenance_work_mem",
  "max_slot_wal_keep_size",
  "max_standby_archive_delay",
  "max_standby_streaming_delay",
  "max_wal_size",
  "shared_buffers",
  "statement_timeout",
  "track_activity_query_size",
  "wal_keep_size",
  "wal_sender_timeout",
  "work_mem",
];

const sessionReplicationRolePath = ["database", "postgres_settings", "session_replication_role"];

/**
 * `session_replication_role` is a closed enum on the config side
 * (`"origin" | "replica" | "local"`, `../db.ts:55-60`), but the lenient API
 * mirror (`./api-attributes.ts`) deliberately widens it to a plain string
 * (ADR 0019 rule 2) so a new enum member the platform starts returning
 * doesn't fail decode. Left in the generic `DB_SETTINGS_STRING_KEYS` loop,
 * such a value would land in the typed output unguarded and be type-invalid
 * against the config schema, so this row special-cases it out with the same
 * enum guard as `poolerPoolModePath`, below: an unrecognized value omits the
 * field rather than throwing — it stays reachable via `_apiResponse`.
 */
const sessionReplicationRoleRow: ProjectConfigMappingRow = {
  configPath: ["db", "settings", "session_replication_role"],
  apiPath: sessionReplicationRolePath,
  transform: (value) => {
    const role = expectString(value, sessionReplicationRolePath);
    return role === "origin" || role === "replica" || role === "local" ? role : undefined;
  },
};

function dbSettingRow(
  key: string,
  narrow: (value: unknown, apiPath: ReadonlyArray<string>) => unknown,
): ProjectConfigMappingRow {
  const apiPath = ["database", "postgres_settings", key];
  return {
    configPath: ["db", "settings", key],
    apiPath,
    transform: (value) => narrow(value, apiPath),
  };
}

const dbSettingsRows: ReadonlyArray<ProjectConfigMappingRow> = [
  ...DB_SETTINGS_STRING_KEYS.map((key) => dbSettingRow(key, expectString)),
  sessionReplicationRoleRow,
  dbSettingRow("track_commit_timestamp", expectBoolean),
  ...DB_SETTINGS_UINT_KEYS.map((key) => ({
    ...dbSettingRow(key, (value, apiPath) => clampToUint(expectInteger(value, apiPath))),
    normalizeDocument: clampDocumentUint,
  })),
];

const networkRestrictionsAllowedCidrsPath = ["database", "network_restrictions", "allowed_cidrs"];

/**
 * v2 reports allowed CIDRs as one array with a `type` tag (`{address, type:
 * "v4"|"v6"}[]`), where v1 (and this registry's config-side counterpart)
 * split them into two pre-filtered arrays — `db.sync.ts:153-154` reads
 * `remote.config.dbAllowedCidrs`/`dbAllowedCidrsV6` directly from a v1
 * response shaped that way already. Both `allowed_cidrs`/`allowed_cidrs_v6`
 * rows below read this same `apiPath` and filter by `type` to reconstruct
 * that split.
 *
 * Throws rather than silently dropping a malformed entry: this field is a
 * security allowlist, so a partially-filtered result (e.g. one malformed
 * entry silently excluded from `allowed_cidrs`) would misreport "the remote
 * removed your restrictions" — loud beats silent here, unlike the rest of
 * this registry's lenient-toward-unknown-shapes default.
 */
function filterCidrAddresses(
  value: unknown,
  apiPath: ReadonlyArray<string>,
  ipVersion: "v4" | "v6",
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw cidrParseError("an array", value, apiPath);
  }
  const addresses: Array<string> = [];
  for (const entry of value) {
    if (
      !isObject(entry) ||
      typeof entry["address"] !== "string" ||
      (entry["type"] !== "v4" && entry["type"] !== "v6")
    ) {
      throw cidrParseError('{"address": string, "type": "v4" | "v6"}', entry, apiPath);
    }
    if (entry["type"] === ipVersion) {
      addresses.push(entry["address"]);
    }
  }
  return addresses;
}

function cidrParseError(
  expected: string,
  value: unknown,
  apiPath: ReadonlyArray<string>,
): ProjectConfigParseError {
  const detail = `expected ${expected}, got ${value === null ? "null" : typeof value}`;
  return new ProjectConfigParseError({
    apiPath,
    cause: new Error(detail),
    message: formatProjectConfigParseErrorMessage(detail, apiPath),
    suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
  });
}

const poolerPoolModePath = ["pooler", "pool_mode"];

const dbMajorVersionPath = ["database", "major_version"];
const poolerDefaultPoolSizePath = ["pooler", "default_pool_size"];
const poolerMaxClientConnPath = ["pooler", "max_client_conn"];

const dbSectionRows: ReadonlyArray<ProjectConfigMappingRow> = [
  // No sync precedent — exact name+type match against `../db.ts:88-94`.
  // `null` has no counterpart row, so it's already omitted before this
  // narrows; narrowing here guards a non-`null` non-number value.
  {
    configPath: ["db", "major_version"],
    apiPath: dbMajorVersionPath,
    transform: (value) => (value === null ? undefined : expectInteger(value, dbMajorVersionPath)),
  },
  // v2 flattens what v1 nested under `currentConfig.database`
  // (db.sync.ts:241 `applyRemoteSslEnforcement`).
  {
    configPath: ["db", "ssl_enforcement", "enabled"],
    apiPath: ["database", "ssl_enforced"],
  },
  ...dbSettingsRows,
  {
    configPath: ["db", "network_restrictions", "allowed_cidrs"],
    apiPath: networkRestrictionsAllowedCidrsPath,
    transform: (value) => filterCidrAddresses(value, networkRestrictionsAllowedCidrsPath, "v4"),
    unit: "type-tagged {address,type}[] → filtered string[] (v4)",
  },
  {
    configPath: ["db", "network_restrictions", "allowed_cidrs_v6"],
    apiPath: networkRestrictionsAllowedCidrsPath,
    transform: (value) => filterCidrAddresses(value, networkRestrictionsAllowedCidrsPath, "v6"),
    unit: "type-tagged {address,type}[] → filtered string[] (v6)",
  },
  // Deliberately unmapped (no faithful counterpart): database.
  // network_restrictions.{entitlement,status,updated_at,applied_at}. (There
  // is no `network_restrictions.enabled` on the v2 contract at all — the
  // config-side `db.network_restrictions.enabled` toggle, `../db.ts:167-172`,
  // is a purely local management switch with no API-side counterpart to
  // read from, not an unmapped API field.)
  //
  // Pooler — no sync precedent, name-matched to `../db.ts:95-126`.
  {
    configPath: ["db", "pooler", "pool_mode"],
    apiPath: poolerPoolModePath,
    // The API also allows `"statement"` (`packages/api/src/generated/
    // contracts.ts:11056`); the config schema's `pool_mode` literal only
    // accepts `"transaction"`/`"session"`, so that third value is omitted
    // here — it stays reachable via `_apiResponse`.
    transform: (value) => {
      const mode = expectString(value, poolerPoolModePath);
      return mode === "transaction" || mode === "session" ? mode : undefined;
    },
  },
  {
    configPath: ["db", "pooler", "default_pool_size"],
    apiPath: poolerDefaultPoolSizePath,
    transform: (value) =>
      value === null ? undefined : expectInteger(value, poolerDefaultPoolSizePath),
  },
  {
    configPath: ["db", "pooler", "max_client_conn"],
    apiPath: poolerMaxClientConnPath,
    transform: (value) =>
      value === null ? undefined : expectInteger(value, poolerMaxClientConnPath),
  },
  // Deliberately unmapped (no faithful counterpart): pooler.
  // ignore_startup_parameters, server_idle_timeout, server_lifetime,
  // query_wait_timeout, reserve_pool_size.
];

// === storage =================================================================
// Sync precedent: config-sync/storage.sync.ts:178-209
// (`applyRemoteStorageConfig`), :282-306 (`storageToUpdateBody`).

const BINARY_ABBRS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"] as const;

/**
 * Port of Go's `fmt`-style `%.4g`: at most 4 significant digits, trailing
 * zeros removed, no exponent for the magnitudes `bytesSize` below produces
 * (scaled to `[0, 1024)`). Mirrors the legacy shell's `formatG4`
 * (`apps/cli/src/legacy/shared/legacy-size-units.ts:109-119`).
 */
function formatSignificantDigits(value: number): string {
  if (value === 0) {
    return "0";
  }
  let formatted = value.toPrecision(4);
  if (formatted.includes("e") || formatted.includes("E")) {
    return formatted;
  }
  if (formatted.includes(".")) {
    formatted = formatted.replace(/0+$/, "").replace(/\.$/, "");
  }
  return formatted;
}

/**
 * Formats a byte count as a `"<n><unit>"` string — `docker/go-units`'
 * `BytesSize`, ported at `apps/cli/src/legacy/shared/
 * legacy-size-units.ts:127-136` and used by the legacy shell's remote-apply
 * (`storage.sync.ts:214,223` via `bytesSize()`, kept numeric internally and
 * formatted only at TOML-render time — the legacy precedent for reproducing
 * this formatting here rather than just stringifying the byte count) to
 * re-serialise the API's int64 byte count into the human-readable form
 * `storage.file_size_limit` holds in a config document.
 *
 * This formatting round-trips textually against the *dominant* local
 * spelling: a `BytesSize` string, including the schema default `"50MiB"`
 * (`../storage.ts:13,42-47`'s `fileSizeLimit` union accepts either spelling
 * on decode). It does NOT round-trip against a local document that spells
 * the same limit as a bare number — `../storage.ts:42-47` normalizes a
 * numeric local value to its *decimal* string (`52428800`, not `"50MiB"`) on
 * decode, so the two spellings compare unequal textually even though they
 * denote the same limit. Reconciling that comparison-granularity gap is the
 * diff consumer's job (CLI-2156), not this mapping's.
 */
function bytesSize(size: number): string {
  let value = size;
  let unitIndex = 0;
  const limit = BINARY_ABBRS.length - 1;
  while (value >= 1024 && unitIndex < limit) {
    value = value / 1024;
    unitIndex += 1;
  }
  return `${formatSignificantDigits(value)}${BINARY_ABBRS[unitIndex]}`;
}

const BINARY_MAP: Readonly<Record<string, number>> = {
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
};

const DIGIT_OR_DOT_OR_SPACE = "0123456789. ";

/**
 * Port of `units.RAMInBytes`, replicated verbatim from
 * `apps/cli/src/legacy/shared/legacy-size-units.ts:32-102` — parses a
 * human-readable RAM size (1024-based, case-insensitive, optional trailing
 * `b`) OR a bare decimal byte count (both spellings `../storage.ts:35-46`'s
 * `fileSizeLimit` schema accepts) into bytes. Throws on an unparseable
 * string; used only by {@link canonicalizeFileSizeLimit}, which never lets
 * this throw escape.
 */
function ramInBytes(sizeStr: string): number {
  let sep = -1;
  for (let i = 0; i < sizeStr.length; i++) {
    if (DIGIT_OR_DOT_OR_SPACE.includes(sizeStr.charAt(i))) sep = i;
  }
  if (sep === -1) {
    throw new Error(`invalid size: '${sizeStr}'`);
  }
  let num: string;
  let sfx: string;
  if (sizeStr[sep] !== " ") {
    num = sizeStr.slice(0, sep + 1);
    sfx = sizeStr.slice(sep + 1);
  } else {
    num = sizeStr.slice(0, sep);
    sfx = sizeStr.slice(sep + 1);
  }
  if (
    !/^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)([eE][+-]?\d(?:_?\d)*)?$/.test(num)
  ) {
    throw new Error(`invalid size: '${sizeStr}'`);
  }
  const size = Number.parseFloat(num.replace(/_/g, ""));
  if (!Number.isFinite(size)) {
    throw new Error(`invalid size: '${sizeStr}'`);
  }
  if (size < 0) {
    throw new Error(`invalid size: '${sizeStr}'`);
  }
  if (sfx.length === 0) {
    return Math.trunc(size);
  }
  if (sfx.length > 3) {
    throw new Error(`invalid suffix: '${sfx}'`);
  }
  sfx = sfx.toLowerCase();
  if (sfx[0] === "b") {
    if (sfx.length > 1) {
      throw new Error(`invalid suffix: '${sfx}'`);
    }
    return Math.trunc(size);
  }
  const mul = BINARY_MAP[sfx.charAt(0)];
  if (mul === undefined) {
    throw new Error(`invalid suffix: '${sfx}'`);
  }
  if (sfx.length === 2 && sfx[1] !== "b") {
    throw new Error(`invalid suffix: '${sfx}'`);
  }
  if (sfx.length === 3 && sfx.slice(1) !== "ib") {
    throw new Error(`invalid suffix: '${sfx}'`);
  }
  const bytes = size * mul;
  // A finite numeric component can still overflow through the suffix
  // multiplier (e.g. "1e308KiB") — bytesSize(Infinity) would render
  // "InfinityYiB" instead of leaving the unrepresentable input verbatim.
  if (!Number.isFinite(bytes)) {
    throw new Error(`invalid size: '${sizeStr}'`);
  }
  return Math.trunc(bytes);
}

/**
 * DOCUMENT-side byte-size canonicalization (CLI-2230's duration/byte-size
 * finding): a document spells `storage.file_size_limit` as either a
 * `BytesSize` string (`"50MiB"`) or a bare decimal byte count
 * (`"52428800"`, `../storage.ts:35-46`), while {@link bytesSize} always
 * emits the `BytesSize` spelling. Reparsing via `ramInBytes` and
 * re-formatting via `bytesSize` makes both sides converge on one spelling
 * for one logical limit. Never throws: a document value has already passed
 * schema validation, so an unparsable value (which should not occur) is
 * returned verbatim rather than failing `fromConfigDocument`.
 *
 * Deliberately quantized, not exact: both this function and the API-side row
 * below format their byte count through {@link bytesSize}, which rounds to 4
 * significant digits ({@link formatSignificantDigits}). Two limits within
 * ~0.1% of each other therefore compare equal as `BytesSize` strings even
 * though their raw byte counts differ. This is accepted, not a bug to fix by
 * comparing raw bytes instead: every value a user actually writes in
 * `storage.file_size_limit` (`"50MiB"`, `"1GB"`, …) is exact at 4 significant
 * digits, and the config schema models the field as a string
 * (`../storage.ts`), so the comparison this canonicalization feeds is
 * textual by construction either way.
 */
function canonicalizeFileSizeLimit(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return bytesSize(ramInBytes(value));
  } catch {
    return value;
  }
}

const storageFileSizeLimitPath = ["storage", "file_size_limit"];

const storageSectionRows: ReadonlyArray<ProjectConfigMappingRow> = [
  {
    configPath: ["storage", "file_size_limit"],
    apiPath: storageFileSizeLimitPath,
    // Non-negative: ramInBytes above rejects negative sizes, so formatting a
    // negative API byte count (e.g. "-1B") would persist a value config
    // loading cannot read back.
    transform: (value) =>
      bytesSize(
        expectNumberBetween(
          expectInteger(value, storageFileSizeLimitPath),
          storageFileSizeLimitPath,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      ),
    normalizeDocument: canonicalizeFileSizeLimit,
    unit: 'bytes → BytesSize string (e.g. "50MiB")',
  },
  {
    configPath: ["storage", "image_transformation", "enabled"],
    apiPath: ["storage", "features", "image_transformation", "enabled"],
  },
  {
    configPath: ["storage", "s3_protocol", "enabled"],
    apiPath: ["storage", "features", "s3_protocol", "enabled"],
  },
  {
    configPath: ["storage", "analytics", "enabled"],
    apiPath: ["storage", "features", "iceberg_catalog", "enabled"],
  },
  {
    configPath: ["storage", "analytics", "max_namespaces"],
    apiPath: ["storage", "features", "iceberg_catalog", "max_namespaces"],
    transform: (value) =>
      clampToUint(
        expectInteger(value, ["storage", "features", "iceberg_catalog", "max_namespaces"]),
      ),
    normalizeDocument: clampDocumentUint,
  },
  {
    configPath: ["storage", "analytics", "max_tables"],
    apiPath: ["storage", "features", "iceberg_catalog", "max_tables"],
    transform: (value) =>
      clampToUint(expectInteger(value, ["storage", "features", "iceberg_catalog", "max_tables"])),
    normalizeDocument: clampDocumentUint,
  },
  {
    configPath: ["storage", "analytics", "max_catalogs"],
    apiPath: ["storage", "features", "iceberg_catalog", "max_catalogs"],
    transform: (value) =>
      clampToUint(expectInteger(value, ["storage", "features", "iceberg_catalog", "max_catalogs"])),
    normalizeDocument: clampDocumentUint,
  },
  {
    configPath: ["storage", "vector", "enabled"],
    apiPath: ["storage", "features", "vector_buckets", "enabled"],
  },
  {
    configPath: ["storage", "vector", "max_buckets"],
    apiPath: ["storage", "features", "vector_buckets", "max_buckets"],
    transform: (value) =>
      clampToUint(expectInteger(value, ["storage", "features", "vector_buckets", "max_buckets"])),
    normalizeDocument: clampDocumentUint,
  },
  {
    configPath: ["storage", "vector", "max_indexes"],
    apiPath: ["storage", "features", "vector_buckets", "max_indexes"],
    transform: (value) =>
      clampToUint(expectInteger(value, ["storage", "features", "vector_buckets", "max_indexes"])),
    normalizeDocument: clampDocumentUint,
  },
  // Deliberately unmapped: storage.features.purge_cache.enabled,
  // storage.capabilities.{list_v2,iceberg_catalog}, storage.upstream_target,
  // storage.migration_version, storage.database_pool_mode.
];

// === realtime ================================================================
//
// Zero rows, intentionally. `../realtime.ts`'s config section (`enabled`,
// `ip_version`, `max_header_length`) is entirely local dev-server tuning with
// no hosted-project counterpart; all 12 API `realtime.*` fields
// (`private_only`, `max_concurrent_users`, `max_events_per_second`,
// `max_bytes_per_second`, `max_channels_per_client`, `max_joins_per_second`,
// `max_presence_events_per_second`, `max_payload_size_in_kb`,
// `presence_enabled`, `suspend`, `connection_pool`, `postgres_changes_pool`)
// stay unmapped. Do not add rows here to "fix" `unmappedApiFields` reporting
// them — that report is correct.

/**
 * The full API↔`CliConfig` mapping table: this file's non-auth rows plus
 * `./registry-auth.ts`'s auth rows. `fromApiProjectConfig`/
 * `unmappedApiFields` (`./project-config.ts`) are the only consumers.
 */
export const projectConfigMappingRows: ReadonlyArray<ProjectConfigMappingRow> = [
  ...apiSectionRows,
  ...dbSectionRows,
  ...storageSectionRows,
  ...authMappingRows,
];
