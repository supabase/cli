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
 * The non-auth half of the API↔`CliConfig` mapping table. See the per-section comments for
 * fields that exist on the API side but have no config-side counterpart.
 */

const apiDbSchemaPath = ["api", "db_schema"];
const apiExtraSearchPathPath = ["api", "db_extra_search_path"];
const apiMaxRowsPath = ["api", "max_rows"];

/**
 * True when the remote reports the Data API disabled: an explicit `""` `db_schema`, not an
 * absent one (which means the sparse input simply didn't mention it). The rows below gate on
 * this so a disabled remote maps to exactly `{ api: { enabled: false } }`.
 */
function remoteDataApiDisabled(attributes: Record<string, unknown>): boolean {
  const api = attributes["api"];
  return isObject(api) && api["db_schema"] === "";
}

/**
 * Document-side counterpart of `clampToUint`: the config schema accepts a negative number,
 * but every pull-direction transform clamps what the API reports, so the document spelling
 * must converge on the same reading. Non-numbers pass through unchanged.
 */
function clampDocumentUint(value: unknown): unknown {
  return typeof value === "number" ? clampToUint(value) : value;
}

/**
 * Omits (rather than clamps) `api.max_rows` when the document value is non-positive
 * (including `0` and `NaN`): push only ever sends `max_rows` when it is strictly positive,
 * so any other value never round-trips and asserting it would be drift. Uses `!(value > 0)`
 * rather than `value <= 0` specifically because `NaN <= 0` is `false` — a TOML `nan` value
 * would otherwise ride through and poison every downstream comparison.
 */
function normalizeDocumentMaxRows(value: unknown): unknown {
  return typeof value === "number" && !(value > 0) ? undefined : value;
}

const apiSectionRows: ReadonlyArray<ProjectConfigMappingRow> = [
  {
    configPath: ["api", "schemas"],
    apiPath: apiDbSchemaPath,
    // Validated before the disabled gate: a malformed value must still throw, even when the
    // disabled sentinel would otherwise suppress this field.
    transform: (value, attributes) => {
      const schemas = splitCommaSeparated(expectString(value, apiDbSchemaPath));
      return remoteDataApiDisabled(attributes) ? undefined : schemas;
    },
    // An explicitly empty schemas array is unmanaged absence: push never sends `db_schema`
    // for an empty array (`""` is reserved for the disabled sentinel), so the API side can
    // never project `[]`. Unlike `extra_search_path`, whose empty array does round-trip.
    normalizeDocument: (value) => {
      const canonical = canonicalizeCommaJoinedArray(value);
      return Array.isArray(canonical) && canonical.length === 0 ? undefined : canonical;
    },
    unit: "csv → string[]",
  },
  {
    // Derived from the same `db_schema` field as the row above; multiple rows may share an
    // `apiPath` (see registry-row.ts).
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
    normalizeDocument: normalizeDocumentMaxRows,
  },
  // Unmapped (no config counterpart): api.db_pool, api.db_pool_acquisition_timeout.
];

/** Settings fields whose remote value is a signed int, clamped to uint. */
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
 * The remaining string-passthrough `db.settings` keys. `session_replication_role` is
 * excluded — see {@link sessionReplicationRoleRow}, below.
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
 * `session_replication_role` is a closed enum on the config side, but the lenient API
 * mirror widens it to a plain string (see `docs/adr/0019-config-api-response-passthrough.md`)
 * so a new enum value doesn't fail decode. This row guards it back to the enum, omitting an
 * unrecognized value rather than throwing — it stays reachable via `_apiResponse`.
 */
const sessionReplicationRoleRow: ProjectConfigMappingRow = {
  configPath: ["db", "settings", "session_replication_role"],
  apiPath: sessionReplicationRolePath,
  transform: (value) => {
    const role = expectString(value, sessionReplicationRolePath);
    return role === "origin" || role === "replica" || role === "local" ? role : undefined;
  },
  dualScope: true,
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
    dualScope: true,
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
 * v2 reports allowed CIDRs as one array with a `type` tag (`{address, type: "v4"|"v6"}[]`),
 * where the config side splits them into two arrays; the `allowed_cidrs`/`allowed_cidrs_v6`
 * rows below both read this `apiPath` and filter by `type` to reconstruct that split.
 *
 * Throws rather than silently dropping a malformed entry, since this is a security
 * allowlist: a partially-filtered result would misreport "the remote removed your
 * restrictions."
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
  // `null` already has no counterpart row and is omitted before this narrows.
  {
    configPath: ["db", "major_version"],
    apiPath: dbMajorVersionPath,
    transform: (value) => (value === null ? undefined : expectInteger(value, dbMajorVersionPath)),
    dualScope: true,
  },
  // v2 flattens what v1 nested under `currentConfig.database`.
  {
    configPath: ["db", "ssl_enforcement", "enabled"],
    apiPath: ["database", "ssl_enforced"],
  },
  ...dbSettingsRows,
  {
    configPath: ["db", "network_restrictions", "allowed_cidrs"],
    apiPath: networkRestrictionsAllowedCidrsPath,
    transform: (value) => filterCidrAddresses(value, networkRestrictionsAllowedCidrsPath, "v4"),
    // Matches `config push`'s own order-sensitive network-restrictions diff.
    arrayEquality: "sequence",
    unit: "type-tagged {address,type}[] → filtered string[] (v4)",
  },
  {
    configPath: ["db", "network_restrictions", "allowed_cidrs_v6"],
    apiPath: networkRestrictionsAllowedCidrsPath,
    transform: (value) => filterCidrAddresses(value, networkRestrictionsAllowedCidrsPath, "v6"),
    // Matches `config push`'s own order-sensitive network-restrictions diff.
    arrayEquality: "sequence",
    unit: "type-tagged {address,type}[] → filtered string[] (v6)",
  },
  // Unmapped (no faithful counterpart): database.network_restrictions.{entitlement,status,
  // updated_at,applied_at}. `db.network_restrictions.enabled` has no API-side counterpart at
  // all — it's a purely local management switch, not an unmapped API field.
  {
    configPath: ["db", "pooler", "pool_mode"],
    apiPath: poolerPoolModePath,
    // The API also allows `"statement"`; the config schema only accepts `"transaction"` or
    // `"session"`, so that value is omitted here — it stays reachable via `_apiResponse`.
    transform: (value) => {
      const mode = expectString(value, poolerPoolModePath);
      return mode === "transaction" || mode === "session" ? mode : undefined;
    },
    dualScope: true,
  },
  {
    configPath: ["db", "pooler", "default_pool_size"],
    apiPath: poolerDefaultPoolSizePath,
    transform: (value) =>
      value === null ? undefined : expectInteger(value, poolerDefaultPoolSizePath),
    dualScope: true,
  },
  {
    configPath: ["db", "pooler", "max_client_conn"],
    apiPath: poolerMaxClientConnPath,
    transform: (value) =>
      value === null ? undefined : expectInteger(value, poolerMaxClientConnPath),
    dualScope: true,
  },
  // Unmapped (no faithful counterpart): pooler.ignore_startup_parameters,
  // server_idle_timeout, server_lifetime, query_wait_timeout, reserve_pool_size.
];

const BINARY_ABBRS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"] as const;

/**
 * At most 4 significant digits with trailing zeros removed — printf's `%.4g` format. The
 * magnitudes {@link bytesSize} produces (scaled to `[0, 1024)`) never need the exponent form.
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
 * Formats a byte count as a `"<n><unit>"` string (e.g. `"50MiB"`).
 *
 * Round-trips textually against a document that already spells the limit as a `BytesSize`
 * string, but not against one that spells it as a bare number (which normalizes to a decimal
 * string on decode) — reconciling that comparison gap is the diff consumer's job.
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
 * Parses a human-readable RAM size (1024-based, case-insensitive, optional trailing `b`) or
 * a bare decimal byte count into bytes. Throws on an unparseable string; used only by
 * {@link canonicalizeFileSizeLimit}, which never lets this throw escape.
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
  // A finite numeric component can still overflow through the suffix multiplier (e.g.
  // "1e308KiB"); without this check the result would render as "InfinityYiB".
  if (!Number.isFinite(bytes)) {
    throw new Error(`invalid size: '${sizeStr}'`);
  }
  return Math.trunc(bytes);
}

/**
 * Canonicalizes a document's `storage.file_size_limit` to the `BytesSize` spelling
 * {@link bytesSize} emits, so both sides of a diff converge on one spelling. Never throws —
 * an unparsable value returns verbatim. Quantized to 4 significant digits like
 * {@link bytesSize}, so two limits within ~0.1% of each other compare equal as strings; every
 * value a user actually writes is already exact at that precision.
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
    // Non-negative: ramInBytes rejects negative sizes, so a negative API byte count would
    // persist a value config loading can't read back.
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
  // Unmapped: storage.features.purge_cache.enabled, storage.capabilities.{list_v2,
  // iceberg_catalog}, storage.upstream_target, storage.migration_version,
  // storage.database_pool_mode.
];

// Zero rows here, intentionally: `../realtime.ts`'s config section is entirely local
// dev-server tuning with no hosted-project counterpart. Do not add rows to "fix"
// `unmappedApiFields` reporting the API's `realtime.*` fields — that report is correct.

/**
 * The full API↔`CliConfig` mapping table: this file's non-auth rows plus
 * `./registry-auth.ts`'s auth rows.
 */
export const projectConfigMappingRows: ReadonlyArray<ProjectConfigMappingRow> = [
  ...apiSectionRows,
  ...dbSectionRows,
  ...storageSectionRows,
  ...authMappingRows,
];
