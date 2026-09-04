/**
 * Pure encoders that turn the changes routed to one `config push` resource
 * into a v1 update-request body.
 *
 * Encoders take the whole local AND remote projections, not just the
 * changed leaves, because several endpoints need companion values the API
 * requires together (`db_schema` when enabling the Data API, both CIDR
 * arrays, the iceberg/vector containers' required inner keys, the active SMS
 * provider's credential set). The change list decides *which* keys ship; a
 * companion's value always prefers the project's CURRENT (`remote`) value
 * over a schema-materialized local default, so an undeclared companion never
 * gets clobbered with a default the user never asked for. Only when `remote`
 * doesn't report a companion at all does resolution fall through to `local`
 * (and, for the storage feature containers only, the decoded `config`) — and
 * that fallback is disclosed via `forced`, never applied silently.
 */

import type { CliConfig, ConfigChange, ProjectConfig } from "@supabase/config";
import { AUTH_HOOK_NAMES } from "@supabase/config/internal";

import { ramInBytes } from "../../../shared/legacy-size-units.ts";
import { legacyPasswordRequirementsToChar } from "../../../shared/legacy-password-requirements.ts";
import { legacyParseDuration } from "./push.duration.ts";
import {
  legacyComparePaths,
  legacyContainerEnabled,
  legacyIsPrefixOf,
  legacyIsRecord,
  legacyPathIn,
  legacySamePath,
  legacyValueAtPath,
} from "./push.paths.ts";
import {
  LEGACY_EMAIL_NOTIFICATION_NAMES,
  LEGACY_EMAIL_TEMPLATE_NAMES,
  LEGACY_EXTERNAL_PROVIDER_IDS,
  LEGACY_PROVIDERS_WITH_EMAIL_OPTIONAL,
  LEGACY_PROVIDERS_WITH_SKIP_NONCE_CHECK,
  LEGACY_PROVIDERS_WITH_URL,
  LEGACY_SMS_PROVIDER_NAMES,
} from "./push.registry-names.ts";
import type { LegacyAuthEmailContent } from "./push.auth-email-content.ts";
import type { LegacyPushSecretDecision } from "./push.secrets.ts";

export interface LegacyPushEncoderInput {
  /** Pushable changes routed to this resource. */
  readonly changes: ReadonlyArray<ConfigChange>;
  /** `fromConfigDocument(loaded)` — canonical, presence-masked, sentinel-pruned. */
  readonly local: ProjectConfig;
  /** `fromApiProjectConfig(response)` — the project's current effective config. */
  readonly remote: ProjectConfig;
}

/**
 * The storage encoder's own input: adds the decoded `config` as the LAST
 * resort for the `storage.analytics`/`storage.vector` containers' required
 * inner keys, which the local projection prunes entirely once disabled
 * (CLI-2314 readiness). No other encoder needs this fourth tier.
 */
export interface LegacyStorageEncoderInput extends LegacyPushEncoderInput {
  readonly config: CliConfig;
}

export interface LegacyPushEncoded<Body> {
  /** `undefined` = nothing to write for this resource. */
  readonly body: Body | undefined;
  /** Change paths this body communicated, sorted. */
  readonly encoded: ReadonlyArray<ReadonlyArray<string>>;
  /** Pushable changes this endpoint structurally cannot express, sorted. */
  readonly unencodable: ReadonlyArray<{
    readonly path: ReadonlyArray<string>;
    readonly reason: string;
  }>;
  /** Push-only content paths (mailer template/notification HTML) this body communicated — never a registry-comparable change. */
  readonly extras: ReadonlyArray<{
    readonly path: ReadonlyArray<string>;
    readonly label: "content";
  }>;
  /** Undeclared companions the request had to send at a local/schema-default value because `remote` didn't report them, sorted. */
  readonly forced: ReadonlyArray<{ readonly path: ReadonlyArray<string>; readonly value: unknown }>;
  /**
   * Secret paths this body actually placed a plaintext value for, sorted —
   * auth-only (`legacyEncodeAuthBody`); every other encoder omits it, since
   * none of their endpoints carry a secret. A container encoder can drop a
   * `send` decision when its required-together group turns out unencodable
   * (the container's fields end up in `unencodable` instead), so a caller
   * must derive which secrets a write actually sent from here rather than
   * from the raw `send` decision list.
   */
  readonly secretsEncoded?: ReadonlyArray<ReadonlyArray<string>>;
}

export interface LegacyApiUpdateBody {
  readonly db_schema?: string;
  readonly db_extra_search_path?: string;
  readonly max_rows?: number;
}
export type LegacyDbSettingsUpdateBody = Readonly<Record<string, string | number | boolean>>;
export interface LegacyNetworkRestrictionsUpdateBody {
  readonly dbAllowedCidrs: ReadonlyArray<string>;
  readonly dbAllowedCidrsV6: ReadonlyArray<string>;
}
export interface LegacySslEnforcementUpdateBody {
  readonly requestedConfig: { readonly database: boolean };
}
export interface LegacyStorageUpdateBody {
  readonly fileSizeLimit?: number;
  readonly features?: {
    readonly imageTransformation?: { readonly enabled: boolean };
    readonly s3Protocol?: { readonly enabled: boolean };
    readonly icebergCatalog?: {
      readonly enabled: boolean;
      readonly maxNamespaces: number;
      readonly maxTables: number;
      readonly maxCatalogs: number;
    };
    readonly vectorBuckets?: {
      readonly enabled: boolean;
      readonly maxBuckets: number;
      readonly maxIndexes: number;
    };
  };
}

export interface LegacyAuthEncoderInput extends LegacyPushEncoderInput {
  /** Secret send/unchanged/not_set/gated decisions, from `push.secrets.ts`. */
  readonly secrets: ReadonlyArray<LegacyPushSecretDecision>;
  /** HTML bodies loaded from `content_path`, for the unmapped mailer `*_content` keys. */
  readonly emailContent: LegacyAuthEmailContent;
  /** Raw `data.attributes.auth` — for comparing the 13 unmapped mailer `*_content` keys. */
  readonly remoteAuthAttributes: Readonly<Record<string, unknown>>;
  /** Clock value for `sms_test_otp_valid_until` (+10 calendar years). */
  readonly now: Date;
}

// --- shared reasons (D5; everything else is a defensive fallback that the
// mapping registry's own schema validation should make unreachable) --------

const REASON_API_ENABLE_NEEDS_SCHEMA =
  "enabling the Data API needs at least one schema in api.schemas";
const REASON_SMS_ACTIVE_PROVIDER_ONLY =
  "config push can switch between SMS providers but cannot turn the active provider off; disable phone sign-in or use the dashboard";
const REASON_CONTAINER_STATE_UNKNOWN =
  "the container's enabled state could not be determined from the declared config";
const REASON_BYTES_SIZE = "the declared value is not a valid byte size";
const REASON_GROUP_INCOMPLETE = "one or more of this group's required fields could not be resolved";
const REASON_VALUE_NOT_REPRESENTABLE = "the declared value could not be represented in the request";
const REASON_DB_SETTINGS_KEY_SHAPE =
  "only a top-level db.settings.<key> value can be encoded into a Postgres config write";
const REASON_INVALID_DURATION = "the declared value is not a valid duration";
const REASON_API_DISABLED =
  "the Data API is disabled on the project; declare api.enabled = true to apply this";
const REASON_COMPANION_TYPE_MISMATCH =
  "a required companion value has an unexpected type and could not be sent";
const REASON_NO_ENCODER = "config push has no encoder for this property";

// --- generic path/value helpers ---------------------------------------------

function findChange(
  changes: ReadonlyArray<ConfigChange>,
  path: ReadonlyArray<string>,
): ConfigChange | undefined {
  return changes.find((change) => legacySamePath(change.path, path));
}

function changesUnderPrefix(
  changes: ReadonlyArray<ConfigChange>,
  prefix: ReadonlyArray<string>,
): ReadonlyArray<ConfigChange> {
  return changes.filter((change) => legacyIsPrefixOf(prefix, change.path));
}

type LeafSource = "change" | "remote" | "local" | "config" | "none";

interface LeafResolution {
  readonly value: unknown;
  readonly source: LeafSource;
}

/**
 * Resolves a companion value in preference order: the matching routed
 * change's own new value, then the project's current (`remote`) value, then
 * the local projection (which may hold a schema-materialized default rather
 * than a declared value). See this module's header comment for why the
 * order is this way.
 */
function resolveLeaf(
  changes: ReadonlyArray<ConfigChange>,
  path: ReadonlyArray<string>,
  remote: ProjectConfig,
  local: ProjectConfig,
): LeafResolution {
  const change = findChange(changes, path);
  if (change !== undefined) {
    return { value: change.local, source: "change" };
  }
  const fromRemote = legacyValueAtPath(remote, path);
  if (fromRemote !== undefined) {
    return { value: fromRemote, source: "remote" };
  }
  const fromLocal = legacyValueAtPath(local, path);
  if (fromLocal !== undefined) {
    return { value: fromLocal, source: "local" };
  }
  return { value: undefined, source: "none" };
}

/**
 * {@link resolveLeaf}, with a fourth fallback tier for the storage feature
 * containers only: the decoded `config`'s schema-materialized value, for the
 * `max_*` keys the local projection prunes entirely once a feature is
 * disabled.
 */
function resolveStorageFeatureLeaf(
  changes: ReadonlyArray<ConfigChange>,
  path: ReadonlyArray<string>,
  remote: ProjectConfig,
  local: ProjectConfig,
  prunedFallback: CliConfig,
): LeafResolution {
  const resolved = resolveLeaf(changes, path, remote, local);
  if (resolved.source !== "none") {
    return resolved;
  }
  const fromConfig = legacyValueAtPath(prunedFallback, path);
  return fromConfig === undefined ? resolved : { value: fromConfig, source: "config" };
}

/** Records a companion as `forced` when it was NOT itself a routed change AND `remote` didn't report it. */
function pushForced(
  forced: Array<{ path: ReadonlyArray<string>; value: unknown }>,
  path: ReadonlyArray<string>,
  resolved: LeafResolution,
): void {
  if (resolved.source === "local" || resolved.source === "config") {
    forced.push({ path, value: resolved.value });
  }
}

function findSecretDecision(
  secrets: ReadonlyArray<LegacyPushSecretDecision>,
  path: ReadonlyArray<string>,
): LegacyPushSecretDecision | undefined {
  return secrets.find((decision) => legacySamePath(decision.path, path));
}

/**
 * The paths a dropped container's `unencodable` entries must cover: its
 * ordinary routed changes, PLUS its own secret's path when that secret was
 * about to be sent — so a container triggered purely by a `send` secret
 * (no ordinary field change at all) is never silently dropped with nothing
 * reported.
 */
function unencodableTargets(
  containerChanges: ReadonlyArray<ConfigChange>,
  secret: LegacyPushSecretDecision | undefined,
): ReadonlyArray<ReadonlyArray<string>> {
  const paths = containerChanges.map((change) => change.path);
  return secret?.status === "send" ? [...paths, secret.path] : paths;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): ReadonlyArray<string> | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function asStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!legacyIsRecord(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      return undefined;
    }
    result[key] = entry;
  }
  return result;
}

function sortByPath<T extends { readonly path: ReadonlyArray<string> }>(
  entries: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return [...entries].sort((a, b) => legacyComparePaths(a.path, b.path));
}

/**
 * Every routed change an encoder receives must land in `encoded`,
 * `unencodable`, or `extras` — never neither. A path missing from all three
 * (a resource path this encoder's own switch/branch logic forgot to handle)
 * is pushed to `unencodable` with {@link REASON_NO_ENCODER} instead of being
 * silently dropped.
 */
function finalizeEncoded<Body>(
  changes: ReadonlyArray<ConfigChange>,
  result: LegacyPushEncoded<Body>,
): LegacyPushEncoded<Body> {
  const covered = [
    ...result.encoded,
    ...result.unencodable.map((entry) => entry.path),
    ...result.extras.map((entry) => entry.path),
  ];
  const missing = changes.filter((change) => !legacyPathIn(change.path, covered));
  if (missing.length === 0) {
    return result;
  }
  return {
    ...result,
    unencodable: sortByPath([
      ...result.unencodable,
      ...missing.map((change) => ({ path: change.path, reason: REASON_NO_ENCODER })),
    ]),
  };
}

/** Wraps an encoder's implementation with the {@link finalizeEncoded} exhaustiveness check,
 *  applied once here rather than at every one of an encoder's internal return points. */
function withExhaustiveness<In extends LegacyPushEncoderInput, Body>(
  encode: (input: In) => LegacyPushEncoded<Body>,
): (input: In) => LegacyPushEncoded<Body> {
  return (input) => finalizeEncoded(input.changes, encode(input));
}

/** Adds one leaf mapping to `body` when `path` has a routed change; `transform` returning
 *  `undefined` marks it unencodable instead, with `reason` (defaulting to the generic
 *  wrong-type reason) rather than always the same catch-all. */
function makeLeafAdder(
  changes: ReadonlyArray<ConfigChange>,
  body: Record<string, unknown>,
  encoded: Array<ReadonlyArray<string>>,
  unencodable: Array<{ path: ReadonlyArray<string>; reason: string }>,
) {
  return (
    path: ReadonlyArray<string>,
    apiKey: string,
    transform: (value: unknown) => unknown,
    reason: string = REASON_VALUE_NOT_REPRESENTABLE,
  ): void => {
    const change = findChange(changes, path);
    if (change === undefined) {
      return;
    }
    const value = transform(change.local);
    if (value === undefined) {
      unencodable.push({ path: change.path, reason });
      return;
    }
    body[apiKey] = value;
    encoded.push(change.path);
  };
}

// --- api ---------------------------------------------------------------------

function encodeApiBody(input: LegacyPushEncoderInput): LegacyPushEncoded<LegacyApiUpdateBody> {
  const { changes, local, remote } = input;
  const encoded: Array<ReadonlyArray<string>> = [];
  const unencodable: Array<{ path: ReadonlyArray<string>; reason: string }> = [];
  const forced: Array<{ path: ReadonlyArray<string>; value: unknown }> = [];

  const enabledChange = findChange(changes, ["api", "enabled"]);
  const schemasChange = findChange(changes, ["api", "schemas"]);
  const extraSearchPathChange = findChange(changes, ["api", "extra_search_path"]);
  const maxRowsChange = findChange(changes, ["api", "max_rows"]);

  // Whether the Data API is currently disabled and staying that way: `enabled`
  // itself is not a routed change, and its resolved (remote-preferred) value
  // is `false`. Every OTHER api.* change is then meaningless to send — there
  // is no live Data API for the platform to apply it to — so each routes to
  // `unencodable` instead of either silently riding along inside the `""`
  // disable sentinel (a schemas-only change would otherwise be swallowed by
  // it) or being sent on its own to an endpoint that ignores it while
  // disabled.
  const apiDisabled =
    enabledChange === undefined &&
    asBoolean(resolveLeaf(changes, ["api", "enabled"], remote, local).value) === false;

  let dbSchema: string | undefined;
  if (enabledChange !== undefined || schemasChange !== undefined) {
    const triggerPaths = [enabledChange, schemasChange]
      .filter((change): change is ConfigChange => change !== undefined)
      .map((change) => change.path);

    if (apiDisabled) {
      for (const path of triggerPaths) {
        unencodable.push({ path, reason: REASON_API_DISABLED });
      }
    } else {
      const enabledResolved = resolveLeaf(changes, ["api", "enabled"], remote, local);
      const enabled = asBoolean(enabledResolved.value);
      if (enabled === false) {
        dbSchema = "";
        encoded.push(...triggerPaths);
        pushForced(forced, ["api", "enabled"], enabledResolved);
      } else {
        const schemasResolved = resolveLeaf(changes, ["api", "schemas"], remote, local);
        const schemas = asStringArray(schemasResolved.value) ?? [];
        if (schemas.length === 0) {
          for (const path of triggerPaths) {
            unencodable.push({ path, reason: REASON_API_ENABLE_NEEDS_SCHEMA });
          }
        } else {
          dbSchema = schemas.join(",");
          encoded.push(...triggerPaths);
          pushForced(forced, ["api", "enabled"], enabledResolved);
          pushForced(forced, ["api", "schemas"], schemasResolved);
        }
      }
    }
  }

  let dbExtraSearchPath: string | undefined;
  if (extraSearchPathChange !== undefined) {
    if (apiDisabled) {
      unencodable.push({ path: extraSearchPathChange.path, reason: REASON_API_DISABLED });
    } else {
      dbExtraSearchPath = (asStringArray(extraSearchPathChange.local) ?? []).join(",");
      encoded.push(extraSearchPathChange.path);
    }
  }

  let maxRows: number | undefined;
  if (maxRowsChange !== undefined) {
    if (apiDisabled) {
      unencodable.push({ path: maxRowsChange.path, reason: REASON_API_DISABLED });
    } else {
      const value = asNumber(maxRowsChange.local);
      if (value !== undefined) {
        maxRows = value;
        encoded.push(maxRowsChange.path);
      } else {
        unencodable.push({ path: maxRowsChange.path, reason: REASON_VALUE_NOT_REPRESENTABLE });
      }
    }
  }

  const body: LegacyApiUpdateBody = {
    ...(dbSchema !== undefined ? { db_schema: dbSchema } : {}),
    ...(dbExtraSearchPath !== undefined ? { db_extra_search_path: dbExtraSearchPath } : {}),
    ...(maxRows !== undefined ? { max_rows: maxRows } : {}),
  };
  const hasBody =
    dbSchema !== undefined || dbExtraSearchPath !== undefined || maxRows !== undefined;

  return {
    body: hasBody ? body : undefined,
    encoded: [...encoded].sort(legacyComparePaths),
    unencodable: sortByPath(unencodable),
    extras: [],
    forced: sortByPath(forced),
  };
}

export const legacyEncodeApiBody = withExhaustiveness(encodeApiBody);

// --- db.settings ---------------------------------------------------------

function encodeDbSettingsBody(
  input: LegacyPushEncoderInput,
): LegacyPushEncoded<LegacyDbSettingsUpdateBody> {
  const { changes } = input;
  const body: Record<string, string | number | boolean> = {};
  const encoded: Array<ReadonlyArray<string>> = [];
  const unencodable: Array<{ path: ReadonlyArray<string>; reason: string }> = [];

  for (const change of changes) {
    const key = change.path.at(-1);
    if (
      key === undefined ||
      change.path.length !== 3 ||
      change.path[0] !== "db" ||
      change.path[1] !== "settings"
    ) {
      unencodable.push({ path: change.path, reason: REASON_DB_SETTINGS_KEY_SHAPE });
      continue;
    }
    const value = change.local;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      body[key] = value;
      encoded.push(change.path);
    } else {
      unencodable.push({ path: change.path, reason: REASON_VALUE_NOT_REPRESENTABLE });
    }
  }

  return {
    body: Object.keys(body).length > 0 ? body : undefined,
    encoded: [...encoded].sort(legacyComparePaths),
    unencodable: sortByPath(unencodable),
    extras: [],
    forced: [],
  };
}

export const legacyEncodeDbSettingsBody = withExhaustiveness(encodeDbSettingsBody);

// --- db.network_restrictions -----------------------------------------------

function encodeNetworkRestrictionsBody(
  input: LegacyPushEncoderInput,
): LegacyPushEncoded<LegacyNetworkRestrictionsUpdateBody> {
  const { changes, local, remote } = input;
  const relevant = changesUnderPrefix(changes, ["db", "network_restrictions"]);
  if (relevant.length === 0) {
    return { body: undefined, encoded: [], unencodable: [], extras: [], forced: [] };
  }

  const cidrsResolved = resolveLeaf(
    changes,
    ["db", "network_restrictions", "allowed_cidrs"],
    remote,
    local,
  );
  const cidrsV6Resolved = resolveLeaf(
    changes,
    ["db", "network_restrictions", "allowed_cidrs_v6"],
    remote,
    local,
  );
  if (cidrsResolved.source === "none" || cidrsV6Resolved.source === "none") {
    return {
      body: undefined,
      encoded: [],
      unencodable: relevant.map((change) => ({
        path: change.path,
        reason: REASON_GROUP_INCOMPLETE,
      })),
      extras: [],
      forced: [],
    };
  }

  const forced: Array<{ path: ReadonlyArray<string>; value: unknown }> = [];
  pushForced(forced, ["db", "network_restrictions", "allowed_cidrs"], cidrsResolved);
  pushForced(forced, ["db", "network_restrictions", "allowed_cidrs_v6"], cidrsV6Resolved);

  const allowedCidrs = asStringArray(cidrsResolved.value) ?? [];
  const allowedCidrsV6 = asStringArray(cidrsV6Resolved.value) ?? [];

  return {
    body: { dbAllowedCidrs: allowedCidrs, dbAllowedCidrsV6: allowedCidrsV6 },
    encoded: relevant.map((change) => change.path).sort(legacyComparePaths),
    unencodable: [],
    extras: [],
    forced: sortByPath(forced),
  };
}

export const legacyEncodeNetworkRestrictionsBody = withExhaustiveness(
  encodeNetworkRestrictionsBody,
);

// --- db.ssl_enforcement -----------------------------------------------------

function encodeSslEnforcementBody(
  input: LegacyPushEncoderInput,
): LegacyPushEncoded<LegacySslEnforcementUpdateBody> {
  const { changes } = input;
  const change = findChange(changes, ["db", "ssl_enforcement", "enabled"]);
  if (change === undefined) {
    return { body: undefined, encoded: [], unencodable: [], extras: [], forced: [] };
  }
  const enabled = asBoolean(change.local);
  if (enabled === undefined) {
    return {
      body: undefined,
      encoded: [],
      unencodable: [{ path: change.path, reason: REASON_VALUE_NOT_REPRESENTABLE }],
      extras: [],
      forced: [],
    };
  }
  return {
    body: { requestedConfig: { database: enabled } },
    encoded: [change.path],
    unencodable: [],
    extras: [],
    forced: [],
  };
}

export const legacyEncodeSslEnforcementBody = withExhaustiveness(encodeSslEnforcementBody);

// --- storage -----------------------------------------------------------------

interface LegacyStorageIcebergCatalogBody {
  readonly enabled: boolean;
  readonly maxNamespaces: number;
  readonly maxTables: number;
  readonly maxCatalogs: number;
}

interface LegacyStorageVectorBucketsBody {
  readonly enabled: boolean;
  readonly maxBuckets: number;
  readonly maxIndexes: number;
}

function encodeStorageBody(
  input: LegacyStorageEncoderInput,
): LegacyPushEncoded<LegacyStorageUpdateBody> {
  const { changes, local, remote, config } = input;
  const encoded: Array<ReadonlyArray<string>> = [];
  const unencodable: Array<{ path: ReadonlyArray<string>; reason: string }> = [];
  const forced: Array<{ path: ReadonlyArray<string>; value: unknown }> = [];

  let fileSizeLimit: number | undefined;
  const fileSizeLimitChange = findChange(changes, ["storage", "file_size_limit"]);
  if (fileSizeLimitChange !== undefined) {
    const raw = asString(fileSizeLimitChange.local);
    if (raw !== undefined) {
      try {
        fileSizeLimit = ramInBytes(raw);
        encoded.push(fileSizeLimitChange.path);
      } catch {
        unencodable.push({ path: fileSizeLimitChange.path, reason: REASON_BYTES_SIZE });
      }
    } else {
      unencodable.push({ path: fileSizeLimitChange.path, reason: REASON_BYTES_SIZE });
    }
  }

  let imageTransformation: { readonly enabled: boolean } | undefined;
  const imageTransformationChange = findChange(changes, [
    "storage",
    "image_transformation",
    "enabled",
  ]);
  if (imageTransformationChange !== undefined) {
    const enabled = asBoolean(imageTransformationChange.local);
    if (enabled === undefined) {
      unencodable.push({
        path: imageTransformationChange.path,
        reason: REASON_VALUE_NOT_REPRESENTABLE,
      });
    } else {
      imageTransformation = { enabled };
      encoded.push(imageTransformationChange.path);
    }
  }

  let s3Protocol: { readonly enabled: boolean } | undefined;
  const s3ProtocolChange = findChange(changes, ["storage", "s3_protocol", "enabled"]);
  if (s3ProtocolChange !== undefined) {
    const enabled = asBoolean(s3ProtocolChange.local);
    if (enabled === undefined) {
      unencodable.push({ path: s3ProtocolChange.path, reason: REASON_VALUE_NOT_REPRESENTABLE });
    } else {
      s3Protocol = { enabled };
      encoded.push(s3ProtocolChange.path);
    }
  }

  let icebergCatalog: LegacyStorageIcebergCatalogBody | undefined;
  const analyticsChanges = changesUnderPrefix(changes, ["storage", "analytics"]);
  if (analyticsChanges.length > 0) {
    const analyticsPaths = analyticsChanges.map((change) => change.path);
    const enabledR = resolveStorageFeatureLeaf(
      changes,
      ["storage", "analytics", "enabled"],
      remote,
      local,
      config,
    );
    const maxNamespacesR = resolveStorageFeatureLeaf(
      changes,
      ["storage", "analytics", "max_namespaces"],
      remote,
      local,
      config,
    );
    const maxTablesR = resolveStorageFeatureLeaf(
      changes,
      ["storage", "analytics", "max_tables"],
      remote,
      local,
      config,
    );
    const maxCatalogsR = resolveStorageFeatureLeaf(
      changes,
      ["storage", "analytics", "max_catalogs"],
      remote,
      local,
      config,
    );
    const enabled = asBoolean(enabledR.value);
    const maxNamespaces = asNumber(maxNamespacesR.value);
    const maxTables = asNumber(maxTablesR.value);
    const maxCatalogs = asNumber(maxCatalogsR.value);
    if (
      enabled !== undefined &&
      maxNamespaces !== undefined &&
      maxTables !== undefined &&
      maxCatalogs !== undefined
    ) {
      icebergCatalog = { enabled, maxNamespaces, maxTables, maxCatalogs };
      encoded.push(...analyticsPaths);
      pushForced(forced, ["storage", "analytics", "enabled"], enabledR);
      pushForced(forced, ["storage", "analytics", "max_namespaces"], maxNamespacesR);
      pushForced(forced, ["storage", "analytics", "max_tables"], maxTablesR);
      pushForced(forced, ["storage", "analytics", "max_catalogs"], maxCatalogsR);
    } else {
      for (const path of analyticsPaths) {
        unencodable.push({ path, reason: REASON_GROUP_INCOMPLETE });
      }
    }
  }

  let vectorBuckets: LegacyStorageVectorBucketsBody | undefined;
  const vectorChanges = changesUnderPrefix(changes, ["storage", "vector"]);
  if (vectorChanges.length > 0) {
    const vectorPaths = vectorChanges.map((change) => change.path);
    const enabledR = resolveStorageFeatureLeaf(
      changes,
      ["storage", "vector", "enabled"],
      remote,
      local,
      config,
    );
    const maxBucketsR = resolveStorageFeatureLeaf(
      changes,
      ["storage", "vector", "max_buckets"],
      remote,
      local,
      config,
    );
    const maxIndexesR = resolveStorageFeatureLeaf(
      changes,
      ["storage", "vector", "max_indexes"],
      remote,
      local,
      config,
    );
    const enabled = asBoolean(enabledR.value);
    const maxBuckets = asNumber(maxBucketsR.value);
    const maxIndexes = asNumber(maxIndexesR.value);
    if (enabled !== undefined && maxBuckets !== undefined && maxIndexes !== undefined) {
      vectorBuckets = { enabled, maxBuckets, maxIndexes };
      encoded.push(...vectorPaths);
      pushForced(forced, ["storage", "vector", "enabled"], enabledR);
      pushForced(forced, ["storage", "vector", "max_buckets"], maxBucketsR);
      pushForced(forced, ["storage", "vector", "max_indexes"], maxIndexesR);
    } else {
      for (const path of vectorPaths) {
        unencodable.push({ path, reason: REASON_GROUP_INCOMPLETE });
      }
    }
  }

  const features: NonNullable<LegacyStorageUpdateBody["features"]> = {
    ...(imageTransformation !== undefined ? { imageTransformation } : {}),
    ...(s3Protocol !== undefined ? { s3Protocol } : {}),
    ...(icebergCatalog !== undefined ? { icebergCatalog } : {}),
    ...(vectorBuckets !== undefined ? { vectorBuckets } : {}),
  };
  const hasFeatures = Object.keys(features).length > 0;
  const body: LegacyStorageUpdateBody = {
    ...(fileSizeLimit !== undefined ? { fileSizeLimit } : {}),
    ...(hasFeatures ? { features } : {}),
  };
  const hasBody = fileSizeLimit !== undefined || hasFeatures;

  return {
    body: hasBody ? body : undefined,
    encoded: [...encoded].sort(legacyComparePaths),
    unencodable: sortByPath(unencodable),
    extras: [],
    forced: sortByPath(forced),
  };
}

export const legacyEncodeStorageBody = withExhaustiveness(encodeStorageBody);

// --- auth ----------------------------------------------------------------

/** `undefined` on a non-string or an unparseable duration — never `0`, so an invalid
 *  declared value routes to `unencodable` (via `REASON_INVALID_DURATION`) instead of
 *  silently pushing a zero duration. */
function durationToSeconds(value: unknown): number | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  try {
    return Math.floor(legacyParseDuration(raw) / 1_000_000_000);
  } catch {
    return undefined;
  }
}

/** {@link durationToSeconds}, for the two hours-denominated fields. */
function durationToHours(value: unknown): number | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  try {
    return legacyParseDuration(raw) / 3_600_000_000_000;
  } catch {
    return undefined;
  }
}

function mapRecordToEnvString(record: Readonly<Record<string, string>>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

/**
 * `now` + 10 calendar years, calendar-exact (so leap days are counted — a
 * flat 3650-day offset would land 2-3 days short). `setUTCFullYear` keeps UTC
 * semantics.
 */
function tenYearsFromNow(now: Date): Date {
  const validUntil = new Date(now);
  validUntil.setUTCFullYear(validUntil.getUTCFullYear() + 10);
  return validUntil;
}

function encodeSmtpContainer(
  changes: ReadonlyArray<ConfigChange>,
  remote: ProjectConfig,
  local: ProjectConfig,
  secret: LegacyPushSecretDecision | undefined,
  forced: Array<{ path: ReadonlyArray<string>; value: unknown }>,
  unencodable: Array<{ path: ReadonlyArray<string>; reason: string }>,
  containerChanges: ReadonlyArray<ConfigChange>,
  secretsEncoded: Array<ReadonlyArray<string>>,
): Record<string, unknown> | undefined {
  const containerPath = ["auth", "email", "smtp"];
  const enabled = legacyContainerEnabled(local, containerPath);
  if (enabled === undefined) {
    for (const path of unencodableTargets(containerChanges, secret)) {
      unencodable.push({ path, reason: REASON_CONTAINER_STATE_UNKNOWN });
    }
    return undefined;
  }
  if (!enabled) {
    return { smtp_host: "" };
  }
  const hostR = resolveLeaf(changes, [...containerPath, "host"], remote, local);
  const portR = resolveLeaf(changes, [...containerPath, "port"], remote, local);
  const userR = resolveLeaf(changes, [...containerPath, "user"], remote, local);
  const adminEmailR = resolveLeaf(changes, [...containerPath, "admin_email"], remote, local);
  const senderNameR = resolveLeaf(changes, [...containerPath, "sender_name"], remote, local);
  if ([hostR, portR, userR, adminEmailR, senderNameR].some((r) => r.source === "none")) {
    for (const path of unencodableTargets(containerChanges, secret)) {
      unencodable.push({ path, reason: REASON_GROUP_INCOMPLETE });
    }
    return undefined;
  }
  // A companion that DID resolve but to the wrong runtime type (never
  // expected from a schema-typed `ProjectConfig`, but `remote` is untyped
  // JSON off the wire) must never be silently coerced to `""`/`"0"` below —
  // it makes the whole group unencodable instead.
  if (
    typeof hostR.value !== "string" ||
    typeof portR.value !== "number" ||
    typeof userR.value !== "string" ||
    typeof adminEmailR.value !== "string" ||
    typeof senderNameR.value !== "string"
  ) {
    for (const path of unencodableTargets(containerChanges, secret)) {
      unencodable.push({ path, reason: REASON_COMPANION_TYPE_MISMATCH });
    }
    return undefined;
  }
  pushForced(forced, [...containerPath, "host"], hostR);
  pushForced(forced, [...containerPath, "port"], portR);
  pushForced(forced, [...containerPath, "user"], userR);
  pushForced(forced, [...containerPath, "admin_email"], adminEmailR);
  pushForced(forced, [...containerPath, "sender_name"], senderNameR);

  const body: Record<string, unknown> = {
    smtp_host: asString(hostR.value) ?? "",
    smtp_port: String(asNumber(portR.value) ?? 0),
    smtp_user: asString(userR.value) ?? "",
    smtp_admin_email: asString(adminEmailR.value) ?? "",
    smtp_sender_name: asString(senderNameR.value) ?? "",
  };
  if (secret?.status === "send") {
    body[secret.apiKey] = secret.plaintext;
    secretsEncoded.push(secret.path);
  }
  return body;
}

function encodeCaptchaContainer(
  changes: ReadonlyArray<ConfigChange>,
  remote: ProjectConfig,
  local: ProjectConfig,
  secret: LegacyPushSecretDecision | undefined,
  forced: Array<{ path: ReadonlyArray<string>; value: unknown }>,
  secretsEncoded: Array<ReadonlyArray<string>>,
): Record<string, unknown> | undefined {
  const containerPath = ["auth", "captcha"];
  const enabled = legacyContainerEnabled(local, containerPath);
  if (enabled === undefined) {
    return undefined;
  }
  const body: Record<string, unknown> = { security_captcha_enabled: enabled };
  if (!enabled) {
    return body;
  }
  const providerR = resolveLeaf(changes, [...containerPath, "provider"], remote, local);
  pushForced(forced, [...containerPath, "provider"], providerR);
  const provider = asString(providerR.value);
  if (provider !== undefined) {
    body["security_captcha_provider"] = provider;
  }
  if (secret?.status === "send") {
    body[secret.apiKey] = secret.plaintext;
    secretsEncoded.push(secret.path);
  }
  return body;
}

function encodeHookContainer(
  name: string,
  changes: ReadonlyArray<ConfigChange>,
  remote: ProjectConfig,
  local: ProjectConfig,
  secret: LegacyPushSecretDecision | undefined,
  forced: Array<{ path: ReadonlyArray<string>; value: unknown }>,
  unencodable: Array<{ path: ReadonlyArray<string>; reason: string }>,
  containerChanges: ReadonlyArray<ConfigChange>,
  secretsEncoded: Array<ReadonlyArray<string>>,
): Record<string, unknown> | undefined {
  const containerPath = ["auth", "hook", name];
  const enabled = legacyContainerEnabled(local, containerPath);
  if (enabled === undefined) {
    for (const path of unencodableTargets(containerChanges, secret)) {
      unencodable.push({ path, reason: REASON_CONTAINER_STATE_UNKNOWN });
    }
    return undefined;
  }
  const body: Record<string, unknown> = { [`hook_${name}_enabled`]: enabled };
  if (!enabled) {
    return body;
  }
  const uriR = resolveLeaf(changes, [...containerPath, "uri"], remote, local);
  if (uriR.source === "none") {
    for (const path of unencodableTargets(containerChanges, secret)) {
      unencodable.push({ path, reason: REASON_GROUP_INCOMPLETE });
    }
    return undefined;
  }
  pushForced(forced, [...containerPath, "uri"], uriR);
  body[`hook_${name}_uri`] = asString(uriR.value) ?? "";
  if (secret?.status === "send") {
    body[secret.apiKey] = secret.plaintext;
    secretsEncoded.push(secret.path);
  }
  return body;
}

function encodeExternalProviderContainer(
  id: string,
  changes: ReadonlyArray<ConfigChange>,
  remote: ProjectConfig,
  local: ProjectConfig,
  secret: LegacyPushSecretDecision | undefined,
  forced: Array<{ path: ReadonlyArray<string>; value: unknown }>,
  unencodable: Array<{ path: ReadonlyArray<string>; reason: string }>,
  containerChanges: ReadonlyArray<ConfigChange>,
  secretsEncoded: Array<ReadonlyArray<string>>,
): Record<string, unknown> | undefined {
  const containerPath = ["auth", "external", id];
  const key = `external_${id}`;
  const enabled = legacyContainerEnabled(local, containerPath);
  if (enabled === undefined) {
    for (const path of unencodableTargets(containerChanges, secret)) {
      unencodable.push({ path, reason: REASON_CONTAINER_STATE_UNKNOWN });
    }
    return undefined;
  }
  const body: Record<string, unknown> = { [`${key}_enabled`]: enabled };
  if (!enabled) {
    return body;
  }
  // Verbatim — even a comma-containing value (apple/google fold an
  // `additional_client_ids` sibling into this on the pull side; the push
  // body has no such key, so nothing here splits it back apart).
  const clientIdR = resolveLeaf(changes, [...containerPath, "client_id"], remote, local);
  const urlR = LEGACY_PROVIDERS_WITH_URL.includes(id)
    ? resolveLeaf(changes, [...containerPath, "url"], remote, local)
    : undefined;
  const emailOptionalR = LEGACY_PROVIDERS_WITH_EMAIL_OPTIONAL.includes(id)
    ? resolveLeaf(changes, [...containerPath, "email_optional"], remote, local)
    : undefined;
  const skipNonceCheckR = LEGACY_PROVIDERS_WITH_SKIP_NONCE_CHECK.includes(id)
    ? resolveLeaf(changes, [...containerPath, "skip_nonce_check"], remote, local)
    : undefined;
  const required = [clientIdR, urlR, emailOptionalR, skipNonceCheckR].filter(
    (resolution): resolution is LeafResolution => resolution !== undefined,
  );
  if (required.some((resolution) => resolution.source === "none")) {
    for (const path of unencodableTargets(containerChanges, secret)) {
      unencodable.push({ path, reason: REASON_GROUP_INCOMPLETE });
    }
    return undefined;
  }
  // Each companion resolved to SOME value above — but a wrong runtime type
  // (client_id/url expect a string, email_optional/skip_nonce_check expect a
  // boolean) must never be silently coerced to `""`/`false` below.
  if (
    typeof clientIdR.value !== "string" ||
    (urlR !== undefined && typeof urlR.value !== "string") ||
    (emailOptionalR !== undefined && typeof emailOptionalR.value !== "boolean") ||
    (skipNonceCheckR !== undefined && typeof skipNonceCheckR.value !== "boolean")
  ) {
    for (const path of unencodableTargets(containerChanges, secret)) {
      unencodable.push({ path, reason: REASON_COMPANION_TYPE_MISMATCH });
    }
    return undefined;
  }
  pushForced(forced, [...containerPath, "client_id"], clientIdR);
  body[`${key}_client_id`] = asString(clientIdR.value) ?? "";
  if (secret?.status === "send") {
    body[secret.apiKey] = secret.plaintext;
    secretsEncoded.push(secret.path);
  }
  if (urlR !== undefined) {
    pushForced(forced, [...containerPath, "url"], urlR);
    body[`${key}_url`] = asString(urlR.value) ?? "";
  }
  if (emailOptionalR !== undefined) {
    pushForced(forced, [...containerPath, "email_optional"], emailOptionalR);
    body[`${key}_email_optional`] = asBoolean(emailOptionalR.value) ?? false;
  }
  if (skipNonceCheckR !== undefined) {
    pushForced(forced, [...containerPath, "skip_nonce_check"], skipNonceCheckR);
    body[`${key}_skip_nonce_check`] = asBoolean(skipNonceCheckR.value) ?? false;
  }
  return body;
}

function encodeActiveSmsProviderBody(
  provider: string,
  changes: ReadonlyArray<ConfigChange>,
  remote: ProjectConfig,
  local: ProjectConfig,
  secrets: ReadonlyArray<LegacyPushSecretDecision>,
  forced: Array<{ path: ReadonlyArray<string>; value: unknown }>,
  unencodable: Array<{ path: ReadonlyArray<string>; reason: string }>,
  containerChanges: ReadonlyArray<ConfigChange>,
  secretsEncoded: Array<ReadonlyArray<string>>,
): Record<string, unknown> | undefined {
  const resolutions: Array<{ key: string; resolution: LeafResolution }> = [];
  const resolve = (key: string): LeafResolution => {
    const resolution = resolveLeaf(changes, ["auth", "sms", provider, key], remote, local);
    resolutions.push({ key, resolution });
    return resolution;
  };
  const field = (key: string): string => asString(resolve(key).value) ?? "";
  // A companion the config schema declares as `optionalKey` (no materialized
  // default) and the API may report as absent: it must never make the whole
  // provider body unencodable. Included only when some tier resolved it; a
  // resolved value still takes part in `forced` disclosure.
  const optionalField = (key: string): string | undefined => {
    const resolution = resolveLeaf(changes, ["auth", "sms", provider, key], remote, local);
    if (resolution.source === "none") return undefined;
    resolutions.push({ key, resolution });
    return asString(resolution.value) ?? "";
  };
  const secretFor = (key: string) => findSecretDecision(secrets, ["auth", "sms", provider, key]);
  // Collected locally rather than pushed straight to `secretsEncoded`: a
  // provider's own secret is applied to `body` INSIDE the switch below,
  // before the `resolutions.some(source === "none")` check that can still
  // discard the whole body — only merged into the caller's list once that
  // check has passed (mirrors `forced`, pushed the same way just below).
  const sentSecretPaths: Array<ReadonlyArray<string>> = [];
  const applySecret = (body: Record<string, unknown>, key: string) => {
    const secret = secretFor(key);
    if (secret?.status === "send") {
      body[secret.apiKey] = secret.plaintext;
      sentSecretPaths.push(secret.path);
    }
  };

  const body: Record<string, unknown> = { sms_provider: provider };
  switch (provider) {
    case "twilio":
      body["sms_twilio_account_sid"] = field("account_sid");
      body["sms_twilio_message_service_sid"] = field("message_service_sid");
      {
        const contentSid = optionalField("content_sid");
        if (contentSid !== undefined) body["sms_twilio_content_sid"] = contentSid;
      }
      applySecret(body, "auth_token");
      break;
    case "twilio_verify":
      body["sms_twilio_verify_account_sid"] = field("account_sid");
      body["sms_twilio_verify_message_service_sid"] = field("message_service_sid");
      applySecret(body, "auth_token");
      break;
    case "messagebird":
      body["sms_messagebird_originator"] = field("originator");
      applySecret(body, "access_key");
      break;
    case "textlocal":
      body["sms_textlocal_sender"] = field("sender");
      applySecret(body, "api_key");
      break;
    case "vonage":
      body["sms_vonage_api_key"] = field("api_key");
      body["sms_vonage_from"] = field("from");
      applySecret(body, "api_secret");
      break;
  }

  // Every field resolved through `field`/`optionalField` above is
  // string-typed; a resolution present but of the wrong runtime type must
  // never have silently fallen through `field`'s `?? ""` default, so it is
  // caught here alongside the "missing entirely" case rather than shipped.
  const missingResolution = resolutions.some(({ resolution }) => resolution.source === "none");
  const wrongTypeResolution = resolutions.some(
    ({ resolution }) => resolution.source !== "none" && typeof resolution.value !== "string",
  );
  if (missingResolution || wrongTypeResolution) {
    const reason = missingResolution ? REASON_GROUP_INCOMPLETE : REASON_COMPANION_TYPE_MISMATCH;
    for (const change of containerChanges) {
      unencodable.push({ path: change.path, reason });
    }
    for (const path of sentSecretPaths) {
      unencodable.push({ path, reason });
    }
    return undefined;
  }
  for (const { key, resolution } of resolutions) {
    pushForced(forced, ["auth", "sms", provider, key], resolution);
  }
  secretsEncoded.push(...sentSecretPaths);
  return body;
}

function invert(value: unknown): boolean | undefined {
  const bool = asBoolean(value);
  return bool === undefined ? undefined : !bool;
}

function charClass(value: unknown): string | undefined {
  const raw = asString(value);
  return raw === undefined ? undefined : legacyPasswordRequirementsToChar(raw);
}

function joinCsv(value: unknown): string {
  return (asStringArray(value) ?? []).join(",");
}

export interface LegacyPushAuthLeafSpec {
  readonly configPath: ReadonlyArray<string>;
  readonly apiKey: string;
  readonly transform: (value: unknown) => unknown;
  /** Overrides `REASON_VALUE_NOT_REPRESENTABLE` when `transform` returning `undefined` has a
   *  more specific cause (e.g. `REASON_INVALID_DURATION`). */
  readonly reason?: string;
}

/**
 * The auth encoder's flat leaf mappings — declared once here so
 * `legacyEncodeAuthBody` and its key-name drift guard
 * (`push.encoders.unit.test.ts`) iterate the SAME source of truth rather than
 * risk disagreeing with each other about an `apiKey`. Every entry not
 * covered here (the smtp/captcha/hook/external-provider/sms-provider
 * containers, the email template/notification loops) builds its `apiKey`
 * from a string template instead of a static path — see those functions.
 */
export const LEGACY_PUSH_AUTH_LEAF_MAP: ReadonlyArray<LegacyPushAuthLeafSpec> = [
  // core scalars
  { configPath: ["auth", "site_url"], apiKey: "site_url", transform: asString },
  {
    configPath: ["auth", "additional_redirect_urls"],
    apiKey: "uri_allow_list",
    transform: joinCsv,
  },
  { configPath: ["auth", "jwt_expiry"], apiKey: "jwt_exp", transform: asNumber },
  {
    configPath: ["auth", "enable_refresh_token_rotation"],
    apiKey: "refresh_token_rotation_enabled",
    transform: asBoolean,
  },
  {
    configPath: ["auth", "refresh_token_reuse_interval"],
    apiKey: "security_refresh_token_reuse_interval",
    transform: asNumber,
  },
  {
    configPath: ["auth", "enable_manual_linking"],
    apiKey: "security_manual_linking_enabled",
    transform: asBoolean,
  },
  { configPath: ["auth", "enable_signup"], apiKey: "disable_signup", transform: invert },
  {
    configPath: ["auth", "enable_anonymous_sign_ins"],
    apiKey: "external_anonymous_users_enabled",
    transform: asBoolean,
  },
  {
    configPath: ["auth", "minimum_password_length"],
    apiKey: "password_min_length",
    transform: asNumber,
  },
  {
    configPath: ["auth", "password_requirements"],
    apiKey: "password_required_characters",
    transform: charClass,
  },

  // rate limits
  {
    configPath: ["auth", "rate_limit", "anonymous_users"],
    apiKey: "rate_limit_anonymous_users",
    transform: asNumber,
  },
  {
    configPath: ["auth", "rate_limit", "token_refresh"],
    apiKey: "rate_limit_token_refresh",
    transform: asNumber,
  },
  {
    configPath: ["auth", "rate_limit", "sign_in_sign_ups"],
    apiKey: "rate_limit_otp",
    transform: asNumber,
  },
  {
    configPath: ["auth", "rate_limit", "token_verifications"],
    apiKey: "rate_limit_verify",
    transform: asNumber,
  },
  {
    configPath: ["auth", "rate_limit", "sms_sent"],
    apiKey: "rate_limit_sms_sent",
    transform: asNumber,
  },
  { configPath: ["auth", "rate_limit", "web3"], apiKey: "rate_limit_web3", transform: asNumber },
  // Only ever a routed change while local SMTP is enabled: the projection
  // prunes this path otherwise (`applyDisabledSentinels`'s cross-section
  // rule), so no extra SMTP gate is needed here.
  {
    configPath: ["auth", "rate_limit", "email_sent"],
    apiKey: "rate_limit_email_sent",
    transform: asNumber,
  },

  // sessions
  {
    configPath: ["auth", "sessions", "timebox"],
    apiKey: "sessions_timebox",
    transform: durationToHours,
    reason: REASON_INVALID_DURATION,
  },
  {
    configPath: ["auth", "sessions", "inactivity_timeout"],
    apiKey: "sessions_inactivity_timeout",
    transform: durationToHours,
    reason: REASON_INVALID_DURATION,
  },

  // mfa
  {
    configPath: ["auth", "mfa", "max_enrolled_factors"],
    apiKey: "mfa_max_enrolled_factors",
    transform: asNumber,
  },
  {
    configPath: ["auth", "mfa", "totp", "enroll_enabled"],
    apiKey: "mfa_totp_enroll_enabled",
    transform: asBoolean,
  },
  {
    configPath: ["auth", "mfa", "totp", "verify_enabled"],
    apiKey: "mfa_totp_verify_enabled",
    transform: asBoolean,
  },
  {
    configPath: ["auth", "mfa", "phone", "enroll_enabled"],
    apiKey: "mfa_phone_enroll_enabled",
    transform: asBoolean,
  },
  {
    configPath: ["auth", "mfa", "phone", "verify_enabled"],
    apiKey: "mfa_phone_verify_enabled",
    transform: asBoolean,
  },
  {
    configPath: ["auth", "mfa", "phone", "otp_length"],
    apiKey: "mfa_phone_otp_length",
    transform: asNumber,
  },
  {
    configPath: ["auth", "mfa", "phone", "template"],
    apiKey: "mfa_phone_template",
    transform: asString,
  },
  {
    configPath: ["auth", "mfa", "phone", "max_frequency"],
    apiKey: "mfa_phone_max_frequency",
    transform: durationToSeconds,
    reason: REASON_INVALID_DURATION,
  },
  {
    configPath: ["auth", "mfa", "web_authn", "enroll_enabled"],
    apiKey: "mfa_web_authn_enroll_enabled",
    transform: asBoolean,
  },
  {
    configPath: ["auth", "mfa", "web_authn", "verify_enabled"],
    apiKey: "mfa_web_authn_verify_enabled",
    transform: asBoolean,
  },

  // email base
  {
    configPath: ["auth", "email", "enable_signup"],
    apiKey: "external_email_enabled",
    transform: asBoolean,
  },
  {
    configPath: ["auth", "email", "double_confirm_changes"],
    apiKey: "mailer_secure_email_change_enabled",
    transform: asBoolean,
  },
  {
    configPath: ["auth", "email", "enable_confirmations"],
    apiKey: "mailer_autoconfirm",
    transform: invert,
  },
  { configPath: ["auth", "email", "otp_length"], apiKey: "mailer_otp_length", transform: asNumber },
  { configPath: ["auth", "email", "otp_expiry"], apiKey: "mailer_otp_exp", transform: asNumber },
  {
    configPath: ["auth", "email", "secure_password_change"],
    apiKey: "security_update_password_require_reauthentication",
    transform: asBoolean,
  },
  {
    configPath: ["auth", "email", "max_frequency"],
    apiKey: "smtp_max_frequency",
    transform: durationToSeconds,
    reason: REASON_INVALID_DURATION,
  },

  // sms base
  {
    configPath: ["auth", "sms", "enable_signup"],
    apiKey: "external_phone_enabled",
    transform: asBoolean,
  },
  {
    configPath: ["auth", "sms", "max_frequency"],
    apiKey: "sms_max_frequency",
    transform: durationToSeconds,
    reason: REASON_INVALID_DURATION,
  },
  {
    configPath: ["auth", "sms", "enable_confirmations"],
    apiKey: "sms_autoconfirm",
    transform: asBoolean,
  },
  { configPath: ["auth", "sms", "template"], apiKey: "sms_template", transform: asString },
  { configPath: ["auth", "sms", "otp_length"], apiKey: "sms_otp_length", transform: asNumber },
  { configPath: ["auth", "sms", "otp_expiry"], apiKey: "sms_otp_exp", transform: asNumber },

  // web3
  {
    configPath: ["auth", "web3", "solana", "enabled"],
    apiKey: "external_web3_solana_enabled",
    transform: asBoolean,
  },
  {
    configPath: ["auth", "web3", "ethereum", "enabled"],
    apiKey: "external_web3_ethereum_enabled",
    transform: asBoolean,
  },
];

function encodeAuthBody(
  input: LegacyAuthEncoderInput,
): LegacyPushEncoded<Readonly<Record<string, unknown>>> {
  const { changes, local, remote, secrets, emailContent, remoteAuthAttributes, now } = input;
  const body: Record<string, unknown> = {};
  const encoded: Array<ReadonlyArray<string>> = [];
  const unencodable: Array<{ path: ReadonlyArray<string>; reason: string }> = [];
  const extras: Array<{ path: ReadonlyArray<string>; label: "content" }> = [];
  const forced: Array<{ path: ReadonlyArray<string>; value: unknown }> = [];
  // Secret paths a container actually placed a plaintext for — NOT every
  // `send` decision: a container dropped as `unencodable` never reaches the
  // point where its own secret gets assigned to `body`, so this can be a
  // strict subset of `secrets.filter(status === "send")`.
  const secretsEncoded: Array<ReadonlyArray<string>> = [];
  const leaf = makeLeafAdder(changes, body, encoded, unencodable);

  for (const spec of LEGACY_PUSH_AUTH_LEAF_MAP) {
    leaf(spec.configPath, spec.apiKey, spec.transform, spec.reason);
  }

  // smtp (container)
  const smtpChanges = changesUnderPrefix(changes, ["auth", "email", "smtp"]);
  const smtpSecret = findSecretDecision(secrets, ["auth", "email", "smtp", "pass"]);
  if (smtpChanges.length > 0 || smtpSecret?.status === "send") {
    const smtpBody = encodeSmtpContainer(
      changes,
      remote,
      local,
      smtpSecret,
      forced,
      unencodable,
      smtpChanges,
      secretsEncoded,
    );
    if (smtpBody !== undefined) {
      Object.assign(body, smtpBody);
      encoded.push(...smtpChanges.map((change) => change.path));
    }
  }

  // email templates (subjects, leaf) + template content (push-only, extras)
  for (const name of LEGACY_EMAIL_TEMPLATE_NAMES) {
    leaf(["auth", "email", "template", name, "subject"], `mailer_subjects_${name}`, asString);
    const content = emailContent.template[name];
    if (content === undefined) {
      continue;
    }
    const apiKey = `mailer_templates_${name}_content`;
    const remoteValue = remoteAuthAttributes[apiKey];
    if (typeof remoteValue === "string" && remoteValue === content) {
      continue;
    }
    body[apiKey] = content;
    extras.push({ path: ["auth", "email", "template", name, "content"], label: "content" });
  }

  // notifications (enabled + subject, leaf) + notification content (push-only, extras)
  for (const name of LEGACY_EMAIL_NOTIFICATION_NAMES) {
    leaf(
      ["auth", "email", "notification", name, "enabled"],
      `mailer_notifications_${name}_enabled`,
      asBoolean,
    );
    leaf(
      ["auth", "email", "notification", name, "subject"],
      `mailer_subjects_${name}_notification`,
      asString,
    );
    const content = emailContent.notification[name];
    if (content === undefined) {
      continue;
    }
    const apiKey = `mailer_templates_${name}_notification_content`;
    const remoteValue = remoteAuthAttributes[apiKey];
    if (typeof remoteValue === "string" && remoteValue === content) {
      continue;
    }
    body[apiKey] = content;
    extras.push({ path: ["auth", "email", "notification", name, "content"], label: "content" });
  }

  // captcha (container)
  const captchaChanges = changesUnderPrefix(changes, ["auth", "captcha"]);
  const captchaSecret = findSecretDecision(secrets, ["auth", "captcha", "secret"]);
  if (captchaChanges.length > 0 || captchaSecret?.status === "send") {
    const captchaBody = encodeCaptchaContainer(
      changes,
      remote,
      local,
      captchaSecret,
      forced,
      secretsEncoded,
    );
    if (captchaBody === undefined) {
      for (const path of unencodableTargets(captchaChanges, captchaSecret)) {
        unencodable.push({ path, reason: REASON_CONTAINER_STATE_UNKNOWN });
      }
    } else {
      Object.assign(body, captchaBody);
      encoded.push(...captchaChanges.map((change) => change.path));
    }
  }

  // hooks (container per hook)
  for (const name of AUTH_HOOK_NAMES) {
    const hookChanges = changesUnderPrefix(changes, ["auth", "hook", name]);
    const hookSecret = findSecretDecision(secrets, ["auth", "hook", name, "secrets"]);
    if (hookChanges.length === 0 && hookSecret?.status !== "send") {
      continue;
    }
    const hookBody = encodeHookContainer(
      name,
      changes,
      remote,
      local,
      hookSecret,
      forced,
      unencodable,
      hookChanges,
      secretsEncoded,
    );
    if (hookBody !== undefined) {
      Object.assign(body, hookBody);
      encoded.push(...hookChanges.map((change) => change.path));
    }
  }

  // sms test otp (whole; the record is always local-authoritative — there is
  // no "current remote value" for a push-only credential map)
  const testOtpChanges = changesUnderPrefix(changes, ["auth", "sms", "test_otp"]);
  if (testOtpChanges.length > 0) {
    const record = asStringRecord(legacyValueAtPath(local, ["auth", "sms", "test_otp"]));
    const otpString = record === undefined ? "" : mapRecordToEnvString(record);
    if (otpString.length > 0) {
      body["sms_test_otp"] = otpString;
      body["sms_test_otp_valid_until"] = tenYearsFromNow(now).toISOString();
      encoded.push(...testOtpChanges.map((change) => change.path));
    } else {
      for (const change of testOtpChanges) {
        unencodable.push({ path: change.path, reason: REASON_VALUE_NOT_REPRESENTABLE });
      }
    }
  }

  // sms providers (whole — active provider only)
  const smsProviderChanges = LEGACY_SMS_PROVIDER_NAMES.flatMap((provider) =>
    changesUnderPrefix(changes, ["auth", "sms", provider]),
  );
  const smsProviderSendSecrets = secrets.filter(
    (decision) =>
      decision.status === "send" &&
      LEGACY_SMS_PROVIDER_NAMES.some((provider) =>
        legacyIsPrefixOf(["auth", "sms", provider], decision.path),
      ),
  );
  if (smsProviderChanges.length > 0 || smsProviderSendSecrets.length > 0) {
    const activeProvider = LEGACY_SMS_PROVIDER_NAMES.find(
      (provider) => legacyContainerEnabled(local, ["auth", "sms", provider]) === true,
    );
    if (activeProvider === undefined) {
      for (const change of smsProviderChanges) {
        unencodable.push({ path: change.path, reason: REASON_SMS_ACTIVE_PROVIDER_ONLY });
      }
      for (const decision of smsProviderSendSecrets) {
        unencodable.push({ path: decision.path, reason: REASON_SMS_ACTIVE_PROVIDER_ONLY });
      }
    } else {
      const providerBody = encodeActiveSmsProviderBody(
        activeProvider,
        changes,
        remote,
        local,
        secrets,
        forced,
        unencodable,
        smsProviderChanges,
        secretsEncoded,
      );
      if (providerBody !== undefined) {
        Object.assign(body, providerBody);
        encoded.push(...smsProviderChanges.map((change) => change.path));
      }
    }
  }

  // external providers (container per provider)
  const triggeredProviderIds = new Set<string>();
  for (const change of changesUnderPrefix(changes, ["auth", "external"])) {
    const id = change.path[2];
    if (id !== undefined && LEGACY_EXTERNAL_PROVIDER_IDS.includes(id)) {
      triggeredProviderIds.add(id);
    }
  }
  for (const id of LEGACY_EXTERNAL_PROVIDER_IDS) {
    if (findSecretDecision(secrets, ["auth", "external", id, "secret"])?.status === "send") {
      triggeredProviderIds.add(id);
    }
  }
  for (const id of LEGACY_EXTERNAL_PROVIDER_IDS) {
    if (!triggeredProviderIds.has(id)) {
      continue;
    }
    const providerChanges = changesUnderPrefix(changes, ["auth", "external", id]);
    const providerSecret = findSecretDecision(secrets, ["auth", "external", id, "secret"]);
    const providerBody = encodeExternalProviderContainer(
      id,
      changes,
      remote,
      local,
      providerSecret,
      forced,
      unencodable,
      providerChanges,
      secretsEncoded,
    );
    if (providerBody !== undefined) {
      Object.assign(body, providerBody);
      encoded.push(...providerChanges.map((change) => change.path));
    }
  }

  return {
    body: Object.keys(body).length > 0 ? body : undefined,
    encoded: [...encoded].sort(legacyComparePaths),
    unencodable: sortByPath(unencodable),
    extras: sortByPath(extras),
    forced: sortByPath(forced),
    secretsEncoded: [...secretsEncoded].sort(legacyComparePaths),
  };
}

export const legacyEncodeAuthBody = withExhaustiveness(encodeAuthBody);
