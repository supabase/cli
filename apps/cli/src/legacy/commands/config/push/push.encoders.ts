/**
 * Pure encoders that turn the changes routed to one `config push` resource
 * into a v1 update-request body.
 *
 * Encoders take the whole local projection, not just the changed leaves,
 * because several endpoints need companion values the API requires
 * together (`db_schema` when enabling the Data API, both CIDR arrays, the
 * iceberg/vector containers' required inner keys, the active SMS provider's
 * credential set). The change list decides *which* keys ship; the
 * projection supplies the *values*.
 */

import type { CliConfig, ProjectConfig } from "@supabase/config";
import type { ConfigChange } from "@supabase/config/internal";
import { AUTH_HOOK_NAMES, projectConfigMappingRows } from "@supabase/config/internal";

import { ramInBytes } from "../../../shared/legacy-size-units.ts";
import { legacyPasswordRequirementsToChar } from "../../../shared/legacy-password-requirements.ts";
import { legacyParseDuration } from "./push.duration.ts";
import type { LegacyAuthEmailContent } from "./push.auth-email-content.ts";
import type { LegacyPushSecretDecision } from "./push.secrets.ts";

export interface LegacyPushEncoderInput {
  /** Pushable changes routed to this resource. */
  readonly changes: ReadonlyArray<ConfigChange>;
  /** `fromConfigDocument(loaded)` — canonical, presence-masked, sentinel-pruned. */
  readonly local: ProjectConfig;
  /**
   * The decoded config, used ONLY as the fallback source for required-together
   * keys the projection prunes (the storage feature containers' `max_*`).
   */
  readonly config: CliConfig;
}

export interface LegacyPushEncoded<Body> {
  /** `undefined` = nothing to write for this resource. */
  readonly body: Body | undefined;
  /** Change paths this body communicates (drives per-service `changes`). */
  readonly encoded: ReadonlyArray<ReadonlyArray<string>>;
  /** Pushable changes this endpoint structurally cannot express. */
  readonly unencodable: ReadonlyArray<ReadonlyArray<string>>;
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

// --- generic path/value helpers ---------------------------------------------

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAtPath(root: unknown, path: ReadonlyArray<string>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function samePath(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

function isPrefixOf(prefix: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

function findChange(
  changes: ReadonlyArray<ConfigChange>,
  path: ReadonlyArray<string>,
): ConfigChange | undefined {
  return changes.find((change) => samePath(change.path, path));
}

function changesUnderPrefix(
  changes: ReadonlyArray<ConfigChange>,
  prefix: ReadonlyArray<string>,
): ReadonlyArray<ConfigChange> {
  return changes.filter((change) => isPrefixOf(prefix, change.path));
}

/**
 * Resolves a companion value for a container/whole write: the matching
 * change's own local value first (correct even when the projection later
 * prunes the container this leaf belonged to), then the local projection,
 * then the decoded config as a last resort (the storage feature containers'
 * `max_*`, which the projection prunes entirely once disabled).
 */
function resolveLeaf(
  changes: ReadonlyArray<ConfigChange>,
  path: ReadonlyArray<string>,
  local: unknown,
  config: unknown,
): unknown {
  const change = findChange(changes, path);
  if (change !== undefined) {
    return change.local;
  }
  const fromLocal = valueAtPath(local, path);
  if (fromLocal !== undefined) {
    return fromLocal;
  }
  return valueAtPath(config, path);
}

function findSecretDecision(
  secrets: ReadonlyArray<LegacyPushSecretDecision>,
  path: ReadonlyArray<string>,
): LegacyPushSecretDecision | undefined {
  return secrets.find((decision) => samePath(decision.path, path));
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
  if (!isRecord(value)) {
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

/** Adds one leaf mapping to `body` when `path` has a routed change; `transform` returning `undefined` marks it unencodable instead. */
function makeLeafAdder(
  changes: ReadonlyArray<ConfigChange>,
  body: Record<string, unknown>,
  encoded: Array<ReadonlyArray<string>>,
  unencodable: Array<ReadonlyArray<string>>,
) {
  return (
    path: ReadonlyArray<string>,
    apiKey: string,
    transform: (value: unknown) => unknown,
  ): void => {
    const change = findChange(changes, path);
    if (change === undefined) {
      return;
    }
    const value = transform(change.local);
    if (value === undefined) {
      unencodable.push(change.path);
      return;
    }
    body[apiKey] = value;
    encoded.push(change.path);
  };
}

// --- api ---------------------------------------------------------------------

export function legacyEncodeApiBody(
  input: LegacyPushEncoderInput,
): LegacyPushEncoded<LegacyApiUpdateBody> {
  const { changes, local, config } = input;
  const encoded: Array<ReadonlyArray<string>> = [];
  const unencodable: Array<ReadonlyArray<string>> = [];

  let dbSchema: string | undefined;
  const enabledChange = findChange(changes, ["api", "enabled"]);
  const schemasChange = findChange(changes, ["api", "schemas"]);
  if (enabledChange !== undefined || schemasChange !== undefined) {
    const triggerPaths: Array<ReadonlyArray<string>> = [];
    if (enabledChange !== undefined) triggerPaths.push(enabledChange.path);
    if (schemasChange !== undefined) triggerPaths.push(schemasChange.path);

    const enabled = resolveLeaf(changes, ["api", "enabled"], local, config);
    if (enabled === false) {
      dbSchema = "";
      encoded.push(...triggerPaths);
    } else {
      const schemas = asStringArray(resolveLeaf(changes, ["api", "schemas"], local, config)) ?? [];
      if (schemas.length === 0) {
        unencodable.push(...triggerPaths);
      } else {
        dbSchema = schemas.join(",");
        encoded.push(...triggerPaths);
      }
    }
  }

  let dbExtraSearchPath: string | undefined;
  const extraSearchPathChange = findChange(changes, ["api", "extra_search_path"]);
  if (extraSearchPathChange !== undefined) {
    dbExtraSearchPath = (asStringArray(extraSearchPathChange.local) ?? []).join(",");
    encoded.push(extraSearchPathChange.path);
  }

  let maxRows: number | undefined;
  const maxRowsChange = findChange(changes, ["api", "max_rows"]);
  if (maxRowsChange !== undefined) {
    const value = asNumber(maxRowsChange.local);
    if (value !== undefined && value > 0) {
      maxRows = value;
      encoded.push(maxRowsChange.path);
    } else {
      unencodable.push(maxRowsChange.path);
    }
  }

  const hasBody = dbSchema !== undefined || dbExtraSearchPath !== undefined || maxRows !== undefined;
  return {
    body: hasBody
      ? { db_schema: dbSchema, db_extra_search_path: dbExtraSearchPath, max_rows: maxRows }
      : undefined,
    encoded,
    unencodable,
  };
}

// --- db.settings ---------------------------------------------------------

export function legacyEncodeDbSettingsBody(
  input: LegacyPushEncoderInput,
): LegacyPushEncoded<LegacyDbSettingsUpdateBody> {
  const { changes } = input;
  const body: Record<string, string | number | boolean> = {};
  const encoded: Array<ReadonlyArray<string>> = [];
  const unencodable: Array<ReadonlyArray<string>> = [];

  for (const change of changes) {
    const key = change.path.at(-1);
    if (key === undefined) {
      continue;
    }
    const value = change.local;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      body[key] = value;
      encoded.push(change.path);
    } else {
      unencodable.push(change.path);
    }
  }

  return { body: Object.keys(body).length > 0 ? body : undefined, encoded, unencodable };
}

// --- db.network_restrictions -----------------------------------------------

export function legacyEncodeNetworkRestrictionsBody(
  input: LegacyPushEncoderInput,
): LegacyPushEncoded<LegacyNetworkRestrictionsUpdateBody> {
  const { changes, local, config } = input;
  const relevant = changesUnderPrefix(changes, ["db", "network_restrictions"]);
  if (relevant.length === 0) {
    return { body: undefined, encoded: [], unencodable: [] };
  }

  const allowedCidrs =
    asStringArray(resolveLeaf(changes, ["db", "network_restrictions", "allowed_cidrs"], local, config)) ??
    [];
  const allowedCidrsV6 =
    asStringArray(
      resolveLeaf(changes, ["db", "network_restrictions", "allowed_cidrs_v6"], local, config),
    ) ?? [];

  return {
    body: { dbAllowedCidrs: allowedCidrs, dbAllowedCidrsV6: allowedCidrsV6 },
    encoded: relevant.map((change) => change.path),
    unencodable: [],
  };
}

// --- db.ssl_enforcement -----------------------------------------------------

export function legacyEncodeSslEnforcementBody(
  input: LegacyPushEncoderInput,
): LegacyPushEncoded<LegacySslEnforcementUpdateBody> {
  const { changes } = input;
  const change = findChange(changes, ["db", "ssl_enforcement", "enabled"]);
  if (change === undefined) {
    return { body: undefined, encoded: [], unencodable: [] };
  }
  const enabled = asBoolean(change.local);
  if (enabled === undefined) {
    return { body: undefined, encoded: [], unencodable: [change.path] };
  }
  return {
    body: { requestedConfig: { database: enabled } },
    encoded: [change.path],
    unencodable: [],
  };
}

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

export function legacyEncodeStorageBody(
  input: LegacyPushEncoderInput,
): LegacyPushEncoded<LegacyStorageUpdateBody> {
  const { changes, local, config } = input;
  const encoded: Array<ReadonlyArray<string>> = [];
  const unencodable: Array<ReadonlyArray<string>> = [];

  let fileSizeLimit: number | undefined;
  const fileSizeLimitChange = findChange(changes, ["storage", "file_size_limit"]);
  if (fileSizeLimitChange !== undefined) {
    const raw = asString(fileSizeLimitChange.local);
    if (raw !== undefined) {
      try {
        fileSizeLimit = ramInBytes(raw);
        encoded.push(fileSizeLimitChange.path);
      } catch {
        unencodable.push(fileSizeLimitChange.path);
      }
    } else {
      unencodable.push(fileSizeLimitChange.path);
    }
  }

  let imageTransformation: { readonly enabled: boolean } | undefined;
  const imageTransformationChange = findChange(changes, ["storage", "image_transformation", "enabled"]);
  if (imageTransformationChange !== undefined) {
    const enabled = asBoolean(imageTransformationChange.local);
    if (enabled === undefined) {
      unencodable.push(imageTransformationChange.path);
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
      unencodable.push(s3ProtocolChange.path);
    } else {
      s3Protocol = { enabled };
      encoded.push(s3ProtocolChange.path);
    }
  }

  let icebergCatalog: LegacyStorageIcebergCatalogBody | undefined;
  const analyticsChanges = changesUnderPrefix(changes, ["storage", "analytics"]);
  if (analyticsChanges.length > 0) {
    const analyticsPaths = analyticsChanges.map((change) => change.path);
    const enabled = asBoolean(resolveLeaf(changes, ["storage", "analytics", "enabled"], local, config));
    const maxNamespaces = asNumber(
      resolveLeaf(changes, ["storage", "analytics", "max_namespaces"], local, config),
    );
    const maxTables = asNumber(
      resolveLeaf(changes, ["storage", "analytics", "max_tables"], local, config),
    );
    const maxCatalogs = asNumber(
      resolveLeaf(changes, ["storage", "analytics", "max_catalogs"], local, config),
    );
    if (
      enabled !== undefined &&
      maxNamespaces !== undefined &&
      maxTables !== undefined &&
      maxCatalogs !== undefined
    ) {
      icebergCatalog = { enabled, maxNamespaces, maxTables, maxCatalogs };
      encoded.push(...analyticsPaths);
    } else {
      unencodable.push(...analyticsPaths);
    }
  }

  let vectorBuckets: LegacyStorageVectorBucketsBody | undefined;
  const vectorChanges = changesUnderPrefix(changes, ["storage", "vector"]);
  if (vectorChanges.length > 0) {
    const vectorPaths = vectorChanges.map((change) => change.path);
    const enabled = asBoolean(resolveLeaf(changes, ["storage", "vector", "enabled"], local, config));
    const maxBuckets = asNumber(
      resolveLeaf(changes, ["storage", "vector", "max_buckets"], local, config),
    );
    const maxIndexes = asNumber(
      resolveLeaf(changes, ["storage", "vector", "max_indexes"], local, config),
    );
    if (enabled !== undefined && maxBuckets !== undefined && maxIndexes !== undefined) {
      vectorBuckets = { enabled, maxBuckets, maxIndexes };
      encoded.push(...vectorPaths);
    } else {
      unencodable.push(...vectorPaths);
    }
  }

  const hasFeatures =
    imageTransformation !== undefined ||
    s3Protocol !== undefined ||
    icebergCatalog !== undefined ||
    vectorBuckets !== undefined;
  const hasBody = fileSizeLimit !== undefined || hasFeatures;

  return {
    body: hasBody
      ? {
          fileSizeLimit,
          features: hasFeatures
            ? { imageTransformation, s3Protocol, icebergCatalog, vectorBuckets }
            : undefined,
        }
      : undefined,
    encoded,
    unencodable,
  };
}

// --- auth ----------------------------------------------------------------

function durationToSeconds(value: unknown): number {
  const raw = asString(value);
  if (raw === undefined) return 0;
  try {
    return Math.floor(legacyParseDuration(raw) / 1_000_000_000);
  } catch {
    return 0;
  }
}

function durationToHours(value: unknown): number {
  const raw = asString(value);
  if (raw === undefined) return 0;
  try {
    return legacyParseDuration(raw) / 3_600_000_000_000;
  } catch {
    return 0;
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

function hasRegistryRowAt(path: ReadonlyArray<string>): boolean {
  return projectConfigMappingRows.some((row) => samePath(row.configPath, path));
}

/** The 19 external-provider ids, derived from every `["auth","external",id,"enabled"]` registry row. */
const EXTERNAL_PROVIDER_IDS: ReadonlyArray<string> = (() => {
  const ids: Array<string> = [];
  for (const row of projectConfigMappingRows) {
    if (
      row.configPath.length === 4 &&
      row.configPath[0] === "auth" &&
      row.configPath[1] === "external" &&
      row.configPath[3] === "enabled"
    ) {
      const id = row.configPath[2];
      if (id !== undefined) ids.push(id);
    }
  }
  return ids;
})();

/** Providers with an `external_<id>_url` field — derived from the registry's own `url` rows. */
const PROVIDERS_WITH_URL: ReadonlySet<string> = new Set(
  EXTERNAL_PROVIDER_IDS.filter((id) => hasRegistryRowAt(["auth", "external", id, "url"])),
);

/** Providers with an `external_<id>_skip_nonce_check` field — google only, derived from its registry row. */
const PROVIDERS_WITH_SKIP_NONCE_CHECK: ReadonlySet<string> = new Set(
  EXTERNAL_PROVIDER_IDS.filter((id) => hasRegistryRowAt(["auth", "external", id, "skip_nonce_check"])),
);

/** The 5 SMS provider names, in the registry's own (precedence) order. */
const SMS_PROVIDER_NAMES: ReadonlyArray<string> = (() => {
  const names: Array<string> = [];
  for (const row of projectConfigMappingRows) {
    if (
      row.configPath.length === 4 &&
      row.configPath[0] === "auth" &&
      row.configPath[1] === "sms" &&
      row.configPath[3] === "enabled" &&
      row.apiPath.length === 2 &&
      row.apiPath[0] === "auth" &&
      row.apiPath[1] === "sms_provider"
    ) {
      const name = row.configPath[2];
      if (name !== undefined) names.push(name);
    }
  }
  return names;
})();

/** The 6 email template names, derived from the registry's `subject` rows. */
const EMAIL_TEMPLATE_NAMES: ReadonlyArray<string> = (() => {
  const names: Array<string> = [];
  for (const row of projectConfigMappingRows) {
    if (
      row.configPath.length === 5 &&
      row.configPath[0] === "auth" &&
      row.configPath[1] === "email" &&
      row.configPath[2] === "template" &&
      row.configPath[4] === "subject"
    ) {
      const name = row.configPath[3];
      if (name !== undefined) names.push(name);
    }
  }
  return names;
})();

/** The 7 email notification names, derived from the registry's `enabled` rows. */
const EMAIL_NOTIFICATION_NAMES: ReadonlyArray<string> = (() => {
  const names: Array<string> = [];
  for (const row of projectConfigMappingRows) {
    if (
      row.configPath.length === 5 &&
      row.configPath[0] === "auth" &&
      row.configPath[1] === "email" &&
      row.configPath[2] === "notification" &&
      row.configPath[4] === "enabled"
    ) {
      const name = row.configPath[3];
      if (name !== undefined) names.push(name);
    }
  }
  return names;
})();

function encodeSmtpContainer(
  changes: ReadonlyArray<ConfigChange>,
  local: ProjectConfig,
  config: CliConfig,
  secrets: ReadonlyArray<LegacyPushSecretDecision>,
): Record<string, unknown> {
  const enabled = asBoolean(resolveLeaf(changes, ["auth", "email", "smtp", "enabled"], local, config)) ?? false;
  if (!enabled) {
    return { smtp_host: "" };
  }
  const body: Record<string, unknown> = {
    smtp_host: asString(resolveLeaf(changes, ["auth", "email", "smtp", "host"], local, config)) ?? "",
    smtp_port: String(
      asNumber(resolveLeaf(changes, ["auth", "email", "smtp", "port"], local, config)) ?? 0,
    ),
    smtp_user: asString(resolveLeaf(changes, ["auth", "email", "smtp", "user"], local, config)) ?? "",
    smtp_admin_email:
      asString(resolveLeaf(changes, ["auth", "email", "smtp", "admin_email"], local, config)) ?? "",
    smtp_sender_name:
      asString(resolveLeaf(changes, ["auth", "email", "smtp", "sender_name"], local, config)) ?? "",
  };
  const secret = findSecretDecision(secrets, ["auth", "email", "smtp", "pass"]);
  if (secret?.status === "send") {
    body[secret.apiKey] = secret.plaintext;
  }
  return body;
}

function encodeCaptchaContainer(
  changes: ReadonlyArray<ConfigChange>,
  local: ProjectConfig,
  config: CliConfig,
  secrets: ReadonlyArray<LegacyPushSecretDecision>,
): Record<string, unknown> {
  const enabled =
    asBoolean(resolveLeaf(changes, ["auth", "captcha", "enabled"], local, config)) ?? false;
  const body: Record<string, unknown> = { security_captcha_enabled: enabled };
  if (!enabled) {
    return body;
  }
  const provider = asString(resolveLeaf(changes, ["auth", "captcha", "provider"], local, config));
  if (provider !== undefined) {
    body["security_captcha_provider"] = provider;
  }
  const secret = findSecretDecision(secrets, ["auth", "captcha", "secret"]);
  if (secret?.status === "send") {
    body[secret.apiKey] = secret.plaintext;
  }
  return body;
}

function encodeHookContainer(
  name: string,
  changes: ReadonlyArray<ConfigChange>,
  local: ProjectConfig,
  config: CliConfig,
  secrets: ReadonlyArray<LegacyPushSecretDecision>,
): Record<string, unknown> {
  const enabled =
    asBoolean(resolveLeaf(changes, ["auth", "hook", name, "enabled"], local, config)) ?? false;
  const body: Record<string, unknown> = { [`hook_${name}_enabled`]: enabled };
  if (!enabled) {
    return body;
  }
  body[`hook_${name}_uri`] = asString(resolveLeaf(changes, ["auth", "hook", name, "uri"], local, config)) ?? "";
  const secret = findSecretDecision(secrets, ["auth", "hook", name, "secrets"]);
  if (secret?.status === "send") {
    body[secret.apiKey] = secret.plaintext;
  }
  return body;
}

function encodeExternalProviderContainer(
  id: string,
  changes: ReadonlyArray<ConfigChange>,
  local: ProjectConfig,
  config: CliConfig,
  secrets: ReadonlyArray<LegacyPushSecretDecision>,
): Record<string, unknown> {
  const key = `external_${id}`;
  const enabled =
    asBoolean(resolveLeaf(changes, ["auth", "external", id, "enabled"], local, config)) ?? false;
  const body: Record<string, unknown> = { [`${key}_enabled`]: enabled };
  if (!enabled) {
    return body;
  }
  // Verbatim — even a comma-containing value (apple/google fold an
  // `additional_client_ids` sibling into this on the pull side; the push
  // body has no such key, so nothing here splits it back apart).
  body[`${key}_client_id`] =
    asString(resolveLeaf(changes, ["auth", "external", id, "client_id"], local, config)) ?? "";
  const secret = findSecretDecision(secrets, ["auth", "external", id, "secret"]);
  if (secret?.status === "send") {
    body[secret.apiKey] = secret.plaintext;
  }
  if (PROVIDERS_WITH_URL.has(id)) {
    body[`${key}_url`] = asString(resolveLeaf(changes, ["auth", "external", id, "url"], local, config)) ?? "";
  }
  body[`${key}_email_optional`] =
    asBoolean(resolveLeaf(changes, ["auth", "external", id, "email_optional"], local, config)) ?? false;
  if (PROVIDERS_WITH_SKIP_NONCE_CHECK.has(id)) {
    body[`${key}_skip_nonce_check`] =
      asBoolean(resolveLeaf(changes, ["auth", "external", id, "skip_nonce_check"], local, config)) ??
      false;
  }
  return body;
}

function encodeActiveSmsProviderBody(
  provider: string,
  changes: ReadonlyArray<ConfigChange>,
  local: ProjectConfig,
  config: CliConfig,
  secrets: ReadonlyArray<LegacyPushSecretDecision>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { sms_provider: provider };
  const field = (key: string) =>
    asString(resolveLeaf(changes, ["auth", "sms", provider, key], local, config)) ?? "";
  const secretFor = (key: string) => findSecretDecision(secrets, ["auth", "sms", provider, key]);
  const applySecret = (key: string) => {
    const secret = secretFor(key);
    if (secret?.status === "send") {
      body[secret.apiKey] = secret.plaintext;
    }
  };

  switch (provider) {
    case "twilio":
      body["sms_twilio_account_sid"] = field("account_sid");
      body["sms_twilio_message_service_sid"] = field("message_service_sid");
      applySecret("auth_token");
      break;
    case "twilio_verify":
      body["sms_twilio_verify_account_sid"] = field("account_sid");
      body["sms_twilio_verify_message_service_sid"] = field("message_service_sid");
      applySecret("auth_token");
      break;
    case "messagebird":
      body["sms_messagebird_originator"] = field("originator");
      applySecret("access_key");
      break;
    case "textlocal":
      body["sms_textlocal_sender"] = field("sender");
      applySecret("api_key");
      break;
    case "vonage":
      body["sms_vonage_api_key"] = field("api_key");
      body["sms_vonage_from"] = field("from");
      applySecret("api_secret");
      break;
  }
  return body;
}

export function legacyEncodeAuthBody(
  input: LegacyAuthEncoderInput,
): LegacyPushEncoded<Readonly<Record<string, unknown>>> {
  const { changes, local, config, secrets, emailContent, remoteAuthAttributes, now } = input;
  const body: Record<string, unknown> = {};
  const encoded: Array<ReadonlyArray<string>> = [];
  const unencodable: Array<ReadonlyArray<string>> = [];
  const leaf = makeLeafAdder(changes, body, encoded, unencodable);

  const invert = (value: unknown): boolean | undefined => {
    const bool = asBoolean(value);
    return bool === undefined ? undefined : !bool;
  };
  const charClass = (value: unknown): string | undefined => {
    const raw = asString(value);
    return raw === undefined ? undefined : legacyPasswordRequirementsToChar(raw);
  };
  const joinCsv = (value: unknown): string => (asStringArray(value) ?? []).join(",");

  // core scalars
  leaf(["auth", "site_url"], "site_url", asString);
  leaf(["auth", "additional_redirect_urls"], "uri_allow_list", joinCsv);
  leaf(["auth", "jwt_expiry"], "jwt_exp", asNumber);
  leaf(["auth", "enable_refresh_token_rotation"], "refresh_token_rotation_enabled", asBoolean);
  leaf(
    ["auth", "refresh_token_reuse_interval"],
    "security_refresh_token_reuse_interval",
    asNumber,
  );
  leaf(["auth", "enable_manual_linking"], "security_manual_linking_enabled", asBoolean);
  leaf(["auth", "enable_signup"], "disable_signup", invert);
  leaf(["auth", "enable_anonymous_sign_ins"], "external_anonymous_users_enabled", asBoolean);
  leaf(["auth", "minimum_password_length"], "password_min_length", asNumber);
  leaf(["auth", "password_requirements"], "password_required_characters", charClass);

  // rate limits
  leaf(["auth", "rate_limit", "anonymous_users"], "rate_limit_anonymous_users", asNumber);
  leaf(["auth", "rate_limit", "token_refresh"], "rate_limit_token_refresh", asNumber);
  leaf(["auth", "rate_limit", "sign_in_sign_ups"], "rate_limit_otp", asNumber);
  leaf(["auth", "rate_limit", "token_verifications"], "rate_limit_verify", asNumber);
  leaf(["auth", "rate_limit", "sms_sent"], "rate_limit_sms_sent", asNumber);
  leaf(["auth", "rate_limit", "web3"], "rate_limit_web3", asNumber);
  // Only ever a routed change while local SMTP is enabled: the projection
  // prunes this path otherwise (`applyDisabledSentinels`'s cross-section
  // rule), so no extra SMTP gate is needed here.
  leaf(["auth", "rate_limit", "email_sent"], "rate_limit_email_sent", asNumber);

  // sessions
  leaf(["auth", "sessions", "timebox"], "sessions_timebox", durationToHours);
  leaf(["auth", "sessions", "inactivity_timeout"], "sessions_inactivity_timeout", durationToHours);

  // mfa
  leaf(["auth", "mfa", "max_enrolled_factors"], "mfa_max_enrolled_factors", asNumber);
  leaf(["auth", "mfa", "totp", "enroll_enabled"], "mfa_totp_enroll_enabled", asBoolean);
  leaf(["auth", "mfa", "totp", "verify_enabled"], "mfa_totp_verify_enabled", asBoolean);
  leaf(["auth", "mfa", "phone", "enroll_enabled"], "mfa_phone_enroll_enabled", asBoolean);
  leaf(["auth", "mfa", "phone", "verify_enabled"], "mfa_phone_verify_enabled", asBoolean);
  leaf(["auth", "mfa", "phone", "otp_length"], "mfa_phone_otp_length", asNumber);
  leaf(["auth", "mfa", "phone", "template"], "mfa_phone_template", asString);
  leaf(["auth", "mfa", "phone", "max_frequency"], "mfa_phone_max_frequency", durationToSeconds);
  leaf(["auth", "mfa", "web_authn", "enroll_enabled"], "mfa_web_authn_enroll_enabled", asBoolean);
  leaf(["auth", "mfa", "web_authn", "verify_enabled"], "mfa_web_authn_verify_enabled", asBoolean);

  // email base
  leaf(["auth", "email", "enable_signup"], "external_email_enabled", asBoolean);
  leaf(["auth", "email", "double_confirm_changes"], "mailer_secure_email_change_enabled", asBoolean);
  leaf(["auth", "email", "enable_confirmations"], "mailer_autoconfirm", invert);
  leaf(["auth", "email", "otp_length"], "mailer_otp_length", asNumber);
  leaf(["auth", "email", "otp_expiry"], "mailer_otp_exp", asNumber);
  leaf(
    ["auth", "email", "secure_password_change"],
    "security_update_password_require_reauthentication",
    asBoolean,
  );
  leaf(["auth", "email", "max_frequency"], "smtp_max_frequency", durationToSeconds);

  // smtp (container)
  const smtpChanges = changesUnderPrefix(changes, ["auth", "email", "smtp"]);
  const smtpSecretSend =
    findSecretDecision(secrets, ["auth", "email", "smtp", "pass"])?.status === "send";
  if (smtpChanges.length > 0 || smtpSecretSend) {
    Object.assign(body, encodeSmtpContainer(changes, local, config, secrets));
    encoded.push(...smtpChanges.map((change) => change.path));
  }

  // email templates (subjects, leaf) + template content (push-only leaf)
  for (const name of EMAIL_TEMPLATE_NAMES) {
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
    encoded.push(["auth", "email", "template", name, "content"]);
  }

  // notifications (enabled + subject, leaf) + notification content (push-only leaf)
  for (const name of EMAIL_NOTIFICATION_NAMES) {
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
    encoded.push(["auth", "email", "notification", name, "content"]);
  }

  // captcha (container)
  const captchaChanges = changesUnderPrefix(changes, ["auth", "captcha"]);
  const captchaSecretSend =
    findSecretDecision(secrets, ["auth", "captcha", "secret"])?.status === "send";
  if (captchaChanges.length > 0 || captchaSecretSend) {
    Object.assign(body, encodeCaptchaContainer(changes, local, config, secrets));
    encoded.push(...captchaChanges.map((change) => change.path));
  }

  // hooks (container per hook)
  for (const name of AUTH_HOOK_NAMES) {
    const hookChanges = changesUnderPrefix(changes, ["auth", "hook", name]);
    const hookSecretSend =
      findSecretDecision(secrets, ["auth", "hook", name, "secrets"])?.status === "send";
    if (hookChanges.length === 0 && !hookSecretSend) {
      continue;
    }
    Object.assign(body, encodeHookContainer(name, changes, local, config, secrets));
    encoded.push(...hookChanges.map((change) => change.path));
  }

  // sms base
  leaf(["auth", "sms", "enable_signup"], "external_phone_enabled", asBoolean);
  leaf(["auth", "sms", "max_frequency"], "sms_max_frequency", durationToSeconds);
  leaf(["auth", "sms", "enable_confirmations"], "sms_autoconfirm", asBoolean);
  leaf(["auth", "sms", "template"], "sms_template", asString);

  // sms test otp (whole)
  const testOtpChanges = changesUnderPrefix(changes, ["auth", "sms", "test_otp"]);
  if (testOtpChanges.length > 0) {
    const record = asStringRecord(valueAtPath(local, ["auth", "sms", "test_otp"]));
    const otpString = record === undefined ? "" : mapRecordToEnvString(record);
    if (otpString.length > 0) {
      body["sms_test_otp"] = otpString;
      body["sms_test_otp_valid_until"] = tenYearsFromNow(now).toISOString();
      encoded.push(...testOtpChanges.map((change) => change.path));
    } else {
      unencodable.push(...testOtpChanges.map((change) => change.path));
    }
  }

  // sms providers (whole — active provider only)
  const smsProviderChanges = SMS_PROVIDER_NAMES.flatMap((provider) =>
    changesUnderPrefix(changes, ["auth", "sms", provider]),
  );
  const smsProviderSecretSend = SMS_PROVIDER_NAMES.some((provider) =>
    secrets.some(
      (decision) => decision.status === "send" && isPrefixOf(["auth", "sms", provider], decision.path),
    ),
  );
  if (smsProviderChanges.length > 0 || smsProviderSecretSend) {
    const activeProvider = SMS_PROVIDER_NAMES.find(
      (provider) =>
        asBoolean(resolveLeaf(changes, ["auth", "sms", provider, "enabled"], local, config)) === true,
    );
    if (activeProvider === undefined) {
      unencodable.push(...smsProviderChanges.map((change) => change.path));
    } else {
      Object.assign(body, encodeActiveSmsProviderBody(activeProvider, changes, local, config, secrets));
      encoded.push(...smsProviderChanges.map((change) => change.path));
    }
  }

  // external providers (container per provider)
  const triggeredProviderIds = new Set<string>();
  for (const change of changesUnderPrefix(changes, ["auth", "external"])) {
    const id = change.path[2];
    if (id !== undefined && EXTERNAL_PROVIDER_IDS.includes(id)) {
      triggeredProviderIds.add(id);
    }
  }
  for (const decision of secrets) {
    if (
      decision.status === "send" &&
      decision.path.length === 4 &&
      decision.path[0] === "auth" &&
      decision.path[1] === "external"
    ) {
      const id = decision.path[2];
      if (id !== undefined) triggeredProviderIds.add(id);
    }
  }
  for (const id of EXTERNAL_PROVIDER_IDS) {
    if (!triggeredProviderIds.has(id)) {
      continue;
    }
    const providerChanges = changesUnderPrefix(changes, ["auth", "external", id]);
    Object.assign(body, encodeExternalProviderContainer(id, changes, local, config, secrets));
    encoded.push(...providerChanges.map((change) => change.path));
  }

  // web3
  leaf(["auth", "web3", "solana", "enabled"], "external_web3_solana_enabled", asBoolean);
  leaf(["auth", "web3", "ethereum", "enabled"], "external_web3_ethereum_enabled", asBoolean);

  return {
    body: Object.keys(body).length > 0 ? body : undefined,
    encoded,
    unencodable,
  };
}
