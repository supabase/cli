import { Schema, SchemaIssue } from "effect";
import type { CliConfig } from "../base.ts";
import { isObject } from "../config-document.ts";
import {
  formatProjectConfigParseErrorMessage,
  PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
  ProjectConfigParseError,
} from "../errors.ts";
import { isSecretPath } from "../lib/secret-paths.ts";
import { deepFreeze, setOwnProperty, type DeepPartial, type EffectiveConfig } from "../sparse.ts";
import {
  ProjectConfigApiAttributesSchema,
  type ProjectConfigApiAttributes,
} from "./api-attributes.ts";
import { HOSTED_SECTION_KEYS, type HostedSectionKey } from "./hosted-sections.ts";
import { AUTH_HOOK_NAMES, unmappedSecretApiPaths } from "./registry-auth.ts";
import { expectString } from "./registry-row.ts";
import { projectConfigMappingRows } from "./registry.ts";

/**
 * A deeply-readonly JSON value, the shape of everything under `_apiResponse` (frozen at attach
 * time). `Array.isArray` narrows to a mutable `any[]` (microsoft/TypeScript#17002), so narrow
 * arrays with a readonly-preserving guard instead, e.g.
 * `(v): v is ReadonlyArray<ReadonlyJsonValue> => Array.isArray(v)`.
 */
export type ReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<ReadonlyJsonValue>
  | { readonly [key: string]: ReadonlyJsonValue };

/**
 * The hosted-project subset of {@link CliConfig}: the sections a Management API project-config
 * response can speak for (`api`, `auth`, `db`, `realtime`, `storage`, `workers`, `experimental`),
 * never the local-only sections that only make sense for a checkout on disk.
 *
 * Sparse (`DeepPartial`) rather than schema-defaulted, since an API response never mentions a
 * field it doesn't manage and defaulting the rest would fabricate drift.
 *
 * `_apiResponse`, attached only by {@link fromApiProjectConfig}, is a non-enumerable, deep-frozen
 * copy of the raw API payload — invisible to serialization and to `../sparse.ts`'s structural
 * walks. It can include an HMAC digest of a secret value, so never log a `ProjectConfig` directly;
 * reattach a dropped `_apiResponse` with {@link attachApiResponse}.
 *
 * Not every field in the seven hosted sections is comparable on both arms; use
 * {@link comparableProjectConfigPaths}/{@link isComparableProjectConfigPath} to restrict a
 * comparison to fields both sides speak for. Per ADR 0021, values are canonicalized toward the
 * state `config push` would converge on rather than mirroring their source verbatim.
 */
export type ProjectConfig = DeepPartial<Pick<CliConfig, HostedSectionKey>> & {
  // Deep-frozen at runtime; a compile-permitted mutation throws a TypeError.
  readonly _apiResponse?: { readonly [key: string]: ReadonlyJsonValue };
};

/**
 * Deep-copies `value` (a hosted-section subtree at `path`), dropping every leaf matching an
 * `x-secret` schema annotation or a member of {@link DOCUMENT_ONLY_LOCAL_PATHS}. Copies rather than
 * aliases, so a caller's secret plaintext never rides along on the returned `ProjectConfig`. A
 * container stripping leaves empty is pruned entirely rather than kept as `{}`; arrays are exempt,
 * since `[]` is itself a meaningful value.
 */
function copyHostedValueForDocument(value: unknown, path: ReadonlyArray<string>): unknown {
  if (Array.isArray(value)) {
    // Copy elements recursively rather than aliasing them, since this function's input is never
    // schema-validated and may still hold objects.
    return value.map((element) => copyHostedValueForDocument(element, path));
  }
  if (isObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      if (isSecretPath(childPath) || isDocumentOnlyLocalPath(childPath)) {
        continue;
      }
      const copied = copyHostedValueForDocument(child, childPath);
      // Prune only a container this copy emptied itself, never one that was already empty — an
      // originally-empty object can be meaningful data (e.g. a record entry's value).
      if (
        isObject(copied) &&
        Object.keys(copied).length === 0 &&
        isObject(child) &&
        Object.keys(child).length > 0
      ) {
        continue;
      }
      setOwnProperty(result, key, copied);
    }
    return result;
  }
  return value;
}

/**
 * Paths inside a hosted section with no real hosted counterpart on either arm, so
 * {@link copyHostedValueForDocument} excludes them from a document-sourced `ProjectConfig`: local
 * bind ports/TLS overrides, `db.pooler`'s `enabled`/`port`, the `db.migrations`/`db.seed` subtrees,
 * every config-side `realtime.*` field, and local-only `experimental.*` engine/backend selection.
 *
 * `db.major_version` and `db.pooler`'s other three fields (`pool_mode`, `default_pool_size`,
 * `max_client_conn`) are real hosted facts and excluded from this list, so `config
 * diff`/`config pull` keep them comparable and can sync them from the platform. `auth.enabled`/
 * `storage.enabled` and `db.network_restrictions.enabled` are also excluded: each is a
 * genuine management opt-out a document can still declare, not a value to hide.
 *
 * Exact-match only; every path below names a static struct field.
 */
export const DOCUMENT_ONLY_LOCAL_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ["api", "port"],
  ["api", "tls"],
  ["api", "external_url"],
  ["db", "port"],
  ["db", "shadow_port"],
  ["db", "health_timeout"],
  ["db", "pooler", "enabled"],
  ["db", "pooler", "port"],
  ["db", "migrations"],
  ["db", "seed"],
  ["realtime", "enabled"],
  ["realtime", "ip_version"],
  ["realtime", "max_header_length"],
  ["experimental", "stack"],
  ["experimental", "orioledb_version"],
  ["experimental", "s3_host"],
  ["experimental", "s3_region"],
  ["experimental", "pgdelta"],
  ["experimental", "inspect"],
];

function isDocumentOnlyLocalPath(path: ReadonlyArray<string>): boolean {
  return DOCUMENT_ONLY_LOCAL_PATHS.some(
    (excluded) =>
      excluded.length === path.length &&
      excluded.every((segment, index) => segment === path[index]),
  );
}

/**
 * Applies every registry row's `normalizeDocument` (`./registry-row.ts`) to `output` in place, at
 * `row.configPath`. A row whose canonicalizer returns `undefined` is removed from `output`,
 * pruning any container the removal empties.
 */
function applyDocumentNormalizations(output: Record<string, unknown>): void {
  for (const row of projectConfigMappingRows) {
    if (row.normalizeDocument === undefined) {
      continue;
    }
    const current = readPath(output, row.configPath);
    if (current === undefined) {
      continue;
    }
    const normalized = row.normalizeDocument(current);
    if (normalized === undefined) {
      removePathAndEmptiedAncestors(output, row.configPath);
    } else {
      writePath(output, row.configPath, normalized);
    }
  }
}

/** Deletes the leaf at `path` from `output`, then deletes each ancestor container the removal left empty. */
function removePathAndEmptiedAncestors(
  output: Record<string, unknown>,
  path: ReadonlyArray<string>,
): void {
  const containers: Array<Record<string, unknown>> = [output];
  let cursor: Record<string, unknown> = output;
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    if (!isObject(next)) {
      return;
    }
    containers.push(next);
    cursor = next;
  }
  for (let index = path.length - 1; index >= 0; index--) {
    const container = containers[index];
    const segment = path[index];
    if (container === undefined || segment === undefined) {
      return;
    }
    delete container[segment];
    if (Object.keys(container).length > 0 || index === 0) {
      return;
    }
  }
}

/**
 * The two policies {@link fromConfigDocument} implements for reading a field absent from both the
 * raw file and the in-memory operand:
 *
 * - `"absent-is-default"`: the operand is a bare {@link EffectiveConfig}. Every value on it is
 *   schema-materialized, so an absent field's value is asserted to be the schema default.
 * - `"absent-is-hands-off"`: the operand is a {@link CliConfigWithRawPresence} pair. For a fixed
 *   list of paths, {@link applyRawPresenceMask} removes an absent raw field from the projection
 *   instead of standing in the schema default. `config diff`/`config pull`/`config push` all use
 *   this policy in production.
 *
 * The two policies agree everywhere except one cell: an absent field whose hosted value has been
 * customized. Under `"absent-is-default"`, that reads back as `remote_only` with `local = <schema
 * default>` — treating `remote_only` as "push this" would silently revert the customization.
 * `"absent-is-hands-off"` closes this for its fixed path list; `diffProjectConfig`'s generic
 * `declared` classification closes it for every other comparable path.
 */
export type ConfigAbsencePolicy = "absent-is-default" | "absent-is-hands-off";

/**
 * A `{ config, document }` pair {@link fromConfigDocument} accepts as an alternative to a bare
 * {@link EffectiveConfig}. Supplying `document` — the raw, pre-decode document object
 * (`LoadedCliConfig.document`, `../config-document.ts`) — selects the `"absent-is-hands-off"`
 * {@link ConfigAbsencePolicy}, since decode alone can't distinguish "declared with a default
 * value" from "never mentioned". `LoadedCliConfig` satisfies this interface structurally, without
 * a cast.
 */
export interface CliConfigWithRawPresence {
  readonly config: EffectiveConfig;
  readonly document?: Record<string, unknown>;
}

/**
 * Reads one property off the `{ config, document }` pair shape, translating a throwing accessor
 * into {@link ProjectConfigParseError} rather than letting a raw `Error` escape.
 */
function readConfigDocumentSourceProperty(input: Record<string, unknown>, key: string): unknown {
  try {
    return input[key];
  } catch (cause) {
    throw new ProjectConfigParseError({
      message: `reading "${key}" threw — fromConfigDocument's { config, document } pair must be plain data, not accessor-backed`,
      cause,
      reason: "caller_misuse",
    });
  }
}

/**
 * Unwraps the two shapes {@link fromConfigDocument} accepts: a bare `EffectiveConfig` operand, or
 * a {@link CliConfigWithRawPresence} pair, decided by presence of an own `config` key.
 *
 * `document` absent, or present as explicit `undefined`, both mean "no masking". A present
 * `document` that isn't a plain object throws rather than silently degrading to unmasked output.
 */
function unwrapConfigDocumentSource(input: Record<string, unknown>): {
  readonly config: unknown;
  readonly document: Record<string, unknown> | undefined;
} {
  if (!Object.hasOwn(input, "config")) {
    return { config: input, document: undefined };
  }
  const config = readConfigDocumentSourceProperty(input, "config");
  if (!Object.hasOwn(input, "document")) {
    return { config, document: undefined };
  }
  const document = readConfigDocumentSourceProperty(input, "document");
  if (document === undefined) {
    return { config, document: undefined };
  }
  if (!isObject(document)) {
    throw callerMisuseError(
      `fromConfigDocument operand's "document" property must be an object when present, got ${nonObjectDescription(document)}`,
    );
  }
  return { config, document };
}

/**
 * Projects a {@link CliConfig} document (or any {@link EffectiveConfig} operand) down to its
 * hosted-section subset: copies each present hosted section, omitting every `x-secret` leaf and
 * every {@link DOCUMENT_ONLY_LOCAL_PATHS} entry, and canonicalizing fields a registry row's
 * `normalizeDocument` covers. The result is always a fresh copy and never carries `_apiResponse`.
 *
 * Not a verbatim projection of `config` (ADR 0021): this and {@link fromApiProjectConfig} both
 * build convergence projections so a local and hosted config compare like for like, applying
 * {@link applySmsProviderPrecedence} and {@link applyDisabledSentinels} in addition to secret
 * omission and canonicalization. Do not render this value to a user as "your local config".
 *
 * How an absent field reads depends on the selected {@link ConfigAbsencePolicy} — pass a
 * {@link CliConfigWithRawPresence} pair instead of a bare `config` whenever a `document` is
 * available (e.g. from `loadCliConfig`) to get the safer `"absent-is-hands-off"` policy; see that
 * type's docstring for the danger this avoids.
 *
 * @throws {@link ProjectConfigParseError} if `config` is not an object, or a normalized value is malformed.
 */
export function fromConfigDocument(config: EffectiveConfig): ProjectConfig;
export function fromConfigDocument(loaded: CliConfigWithRawPresence): ProjectConfig;
// TypeScript doesn't distribute an overload set over a union-typed argument, so an internal caller
// holding the union type needs this explicit third overload.
export function fromConfigDocument(
  source: EffectiveConfig | CliConfigWithRawPresence,
): ProjectConfig;
// The implementation signature stays untyped: TypeScript can't verify a structural pick over
// dynamically-iterated keys reconstructs a `ProjectConfig`. The overloads above are the pinned contract.
export function fromConfigDocument(input: unknown): unknown {
  if (!isObject(input)) {
    throw callerMisuseError(
      `fromConfigDocument operand must be an object, got ${nonObjectDescription(input)}`,
    );
  }
  const { config, document } = unwrapConfigDocumentSource(input);
  if (!isObject(config)) {
    // Only the pair shape's own "config" property can be non-object here; a bare operand's
    // `config` is `input` itself.
    throw callerMisuseError(
      `fromConfigDocument operand's "config" property must be an object, got ${nonObjectDescription(config)}`,
    );
  }
  const result: Record<string, unknown> = {};
  for (const key of HOSTED_SECTION_KEYS) {
    if (Object.hasOwn(config, key)) {
      // Translate a throwing getter anywhere in the operand into the documented failure type;
      // plain data never carries accessors.
      let section: unknown;
      let copied: unknown;
      try {
        section = config[key];
        copied = copyHostedValueForDocument(section, [key]);
      } catch (cause) {
        if (cause instanceof ProjectConfigParseError) {
          throw cause;
        }
        throw new ProjectConfigParseError({
          message: `reading document section "${key}" threw — fromConfigDocument operands must be plain data, not accessor-backed`,
          cause,
          reason: "caller_misuse",
        });
      }
      // A section emptied entirely by secret-stripping is dropped; one the document declared
      // empty survives as declared.
      if (
        isObject(copied) &&
        Object.keys(copied).length === 0 &&
        isObject(section) &&
        Object.keys(section).length > 0
      ) {
        continue;
      }
      setOwnProperty(result, key, copied);
    }
  }
  applyDocumentNormalizations(result);
  applySmsProviderPrecedence(result);
  applyDisabledSentinels(result);
  if (document !== undefined) {
    applyRawPresenceMask(result, document);
  }
  return result;
}

/**
 * At most one SMS provider can be live on the platform; a push selects the first enabled provider
 * in this order and drops the rest, so this flips every later `enabled: true` to `false` to match.
 * Document-arm only — the API arm's five flags all derive from a single discriminator.
 */
export const SMS_PROVIDER_PUSH_PRECEDENCE = [
  "twilio",
  "twilio_verify",
  "messagebird",
  "textlocal",
  "vonage",
] as const;

function applySmsProviderPrecedence(result: Record<string, unknown>): void {
  const sms = readPath(result, ["auth", "sms"]);
  if (!isObject(sms)) {
    return;
  }
  let selected = false;
  for (const provider of SMS_PROVIDER_PUSH_PRECEDENCE) {
    const entry = sms[provider];
    if (!isObject(entry) || entry["enabled"] !== true) {
      continue;
    }
    if (selected) {
      entry["enabled"] = false;
    } else {
      selected = true;
    }
  }
}

/**
 * Sibling fields of a container that go inert the moment that container's own `enabled` is
 * `false` — projecting them would fabricate drift between two representations of the identical
 * disabled state. Handles container-scalar siblings only; record-keyed per-entry sweeps
 * (`auth.external.*`, `auth.hook.*`, `auth.sms.*`) are {@link DISABLED_SENTINEL_ENTRY_SWEEPS}
 * below. Applied to both {@link fromConfigDocument} and {@link fromApiProjectConfig} output, so
 * the two stay symmetric.
 *
 * Excludes `auth`/`storage`'s own top-level `enabled`: that flag toggles the local Docker service,
 * not anything hosted, so pruning on it would hide a genuinely-configured section's real hosted
 * state whenever a user simply isn't running that service locally.
 */
export const DISABLED_SENTINEL_PRUNES: ReadonlyArray<{
  readonly containerPath: ReadonlyArray<string>;
  /** Keys to drop when `enabled === false`; absent = drop every key but `enabled`. */
  readonly dropKeys?: ReadonlyArray<string>;
}> = [
  // `api.enabled` derives from `schemas.length > 0`; `extra_search_path`/`max_rows` configure a
  // PostgREST that isn't exposed while the Data API is off.
  { containerPath: ["api"], dropKeys: ["schemas", "extra_search_path", "max_rows"] },
  // `enabled` here means "manage network restrictions", a management opt-out — the platform has
  // no hosted `network_restrictions.enabled` concept to be symmetric with.
  {
    containerPath: ["db", "network_restrictions"],
    dropKeys: ["allowed_cidrs", "allowed_cidrs_v6"],
  },
  // On the document arm, `enabled` and `host` are independent fields, so a stale `host` can
  // survive `enabled = false`; drop it (and its now-inert siblings) to converge on the same
  // `{enabled: false}` shape the API arm produces.
  {
    containerPath: ["auth", "email", "smtp"],
    dropKeys: ["host", "port", "user", "pass", "admin_email", "sender_name"],
  },
  // The platform genuinely retains a stale `provider` after captcha is turned off; this rule is
  // load-bearing on both arms to suppress that phantom drift.
  { containerPath: ["auth", "captcha"], dropKeys: ["provider", "secret"] },
  // `oauth_server.enabled=false` retains `allow_dynamic_registration`/`authorization_url_path` as
  // inert state; without this prune, every stock `supabase init` project would show a fabricated
  // drift line from its own template.
  {
    containerPath: ["auth", "oauth_server"],
    dropKeys: ["allow_dynamic_registration", "authorization_url_path"],
  },
  // No Iceberg catalog is provisioned while disabled, so these ceilings are inert; without this
  // prune, the stock `supabase init` template would show a fabricated quota-lowering diff.
  {
    containerPath: ["storage", "analytics"],
    dropKeys: ["max_namespaces", "max_tables", "max_catalogs"],
  },
  // Same shape as `storage.analytics` above: no Vector catalog is provisioned while disabled.
  { containerPath: ["storage", "vector"], dropKeys: ["max_buckets", "max_indexes"] },
];

/** Record-shaped containers whose per-entry `enabled: false` keeps only the flag. */
export const DISABLED_SENTINEL_ENTRY_SWEEPS: ReadonlyArray<{
  readonly containerPath: ReadonlyArray<string>;
  /** Restrict the sweep to these entry keys (a container mixing records and scalars). */
  readonly entryKeys?: ReadonlyArray<string>;
}> = [
  { containerPath: ["auth", "external"] },
  { containerPath: ["auth", "hook"] },
  // Reuses SMS_PROVIDER_PUSH_PRECEDENCE's provider list rather than duplicating it.
  { containerPath: ["auth", "sms"], entryKeys: SMS_PROVIDER_PUSH_PRECEDENCE },
];

function pruneDisabledContainer(
  container: Record<string, unknown>,
  dropKeys?: ReadonlyArray<string>,
): void {
  for (const key of dropKeys ?? Object.keys(container)) {
    if (key !== "enabled") {
      delete container[key];
    }
  }
}

function applyDisabledSentinels(result: Record<string, unknown>): void {
  for (const rule of DISABLED_SENTINEL_PRUNES) {
    const container = readPath(result, rule.containerPath);
    if (isObject(container) && container["enabled"] === false) {
      pruneDisabledContainer(container, rule.dropKeys);
    }
  }
  for (const sweep of DISABLED_SENTINEL_ENTRY_SWEEPS) {
    const container = readPath(result, sweep.containerPath);
    if (!isObject(container)) {
      continue;
    }
    const entries = sweep.entryKeys ?? Object.keys(container);
    for (const entryKey of entries) {
      const entry = container[entryKey];
      if (isObject(entry) && entry["enabled"] === false) {
        pruneDisabledContainer(entry);
      }
    }
  }
  // The email rate limit is only managed while SMTP is enabled, but pruning fires only on an
  // explicit `smtp.enabled === false`, never on absence — a sparse response that never mentioned
  // `smtp_host` must not have this value pruned either.
  const authSection = result["auth"];
  if (isObject(authSection)) {
    const email = authSection["email"];
    const smtp = isObject(email) ? email["smtp"] : undefined;
    const smtpExplicitlyDisabled = isObject(smtp) && smtp["enabled"] === false;
    const rateLimit = authSection["rate_limit"];
    if (smtpExplicitlyDisabled && isObject(rateLimit)) {
      delete rateLimit["email_sent"];
      if (Object.keys(rateLimit).length === 0) {
        delete authSection["rate_limit"];
      }
      // The only sentinel that can empty its whole section; every other rule keeps at least `enabled`.
      if (Object.keys(authSection).length === 0) {
        delete result["auth"];
      }
    }
  }
}

/**
 * Implements the `"absent-is-hands-off"` {@link ConfigAbsencePolicy}: removes a subtree from the
 * projection when the raw file never declared it, rather than letting the decoded schema default
 * stand in. Document-arm only, and only when `document` is supplied.
 *
 * Covers a fixed list of paths — `db.ssl_enforcement`, `storage.image_transformation`,
 * `storage.s3_protocol`, `auth.captcha`, the `auth.hook.*` names, `auth.email.smtp`, and
 * `auth.external.*` providers the raw file never declared (`apple` excepted) — not every
 * comparable path. Values that survive still come from the decoded `result`; masking only removes
 * a subtree, it never substitutes a raw value.
 */
function applyRawPresenceMask(
  result: Record<string, unknown>,
  document: Record<string, unknown>,
): void {
  // A value comparison, not `Object.hasOwn`: an explicit `undefined` reads as absent too.
  const isPresent = (container: unknown, key: string): boolean =>
    isObject(container) && container[key] !== undefined;

  const db = document["db"];
  if (!isPresent(db, "ssl_enforcement")) {
    removePathAndEmptiedAncestors(result, ["db", "ssl_enforcement"]);
  }

  const storage = document["storage"];
  if (!isPresent(storage, "image_transformation")) {
    removePathAndEmptiedAncestors(result, ["storage", "image_transformation"]);
  }
  if (!isPresent(storage, "s3_protocol")) {
    removePathAndEmptiedAncestors(result, ["storage", "s3_protocol"]);
  }

  const auth = document["auth"];
  if (!isPresent(auth, "captcha")) {
    removePathAndEmptiedAncestors(result, ["auth", "captcha"]);
  }

  const hook = isObject(auth) ? auth["hook"] : undefined;
  for (const name of AUTH_HOOK_NAMES) {
    if (!isPresent(hook, name)) {
      removePathAndEmptiedAncestors(result, ["auth", "hook", name]);
    }
  }

  const email = isObject(auth) ? auth["email"] : undefined;
  if (!isPresent(email, "smtp")) {
    removePathAndEmptiedAncestors(result, ["auth", "email", "smtp"]);
    // Also drop the rate limit that only applies while SMTP is configured at all.
    removePathAndEmptiedAncestors(result, ["auth", "rate_limit", "email_sent"]);
  }

  // Keep only the raw-declared providers plus the always-retained `apple` default; every other
  // provider decodes present with a schema default that should not survive.
  const external = isObject(auth) ? auth["external"] : undefined;
  const declaredProviders = isObject(external) ? new Set(Object.keys(external)) : new Set<string>();
  const projectedExternal = readPath(result, ["auth", "external"]);
  if (isObject(projectedExternal)) {
    for (const provider of Object.keys(projectedExternal)) {
      if (provider !== "apple" && !declaredProviders.has(provider)) {
        removePathAndEmptiedAncestors(result, ["auth", "external", provider]);
      }
    }
  }
}

/**
 * Unwraps the three shapes a caller might hand `fromApiProjectConfig`: the full envelope
 * (`{data: {type, attributes}}`), the `data` object itself, or bare `attributes` — decided by
 * presence of an own `data` or `attributes` key. A malformed envelope throws rather than falling
 * through to "bare attributes", which would silently map to an empty {@link ProjectConfig}.
 */
function unwrapApiResponse(input: unknown): Record<string, unknown> {
  if (!isObject(input)) {
    const detail = `expected an object, got ${nonObjectDescription(input)}`;
    throw new ProjectConfigParseError({
      message: formatProjectConfigParseErrorMessage(detail),
      cause: new Error(detail),
      suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
    });
  }
  if (Object.hasOwn(input, "data")) {
    const data = readEnvelopeProperty(input, "data");
    if (!isObject(data)) {
      throw envelopeError("data is not an object");
    }
    assertProjectConfigResourceType(data);
    const attributes = readEnvelopeProperty(data, "attributes");
    if (!isObject(attributes)) {
      throw envelopeError("data.attributes is not an object");
    }
    return attributes;
  }
  if (Object.hasOwn(input, "attributes")) {
    assertProjectConfigResourceType(input);
    const attributes = readEnvelopeProperty(input, "attributes");
    if (!isObject(attributes)) {
      throw envelopeError("attributes is not an object");
    }
    return attributes;
  }
  return input;
}

/**
 * Reads one envelope property, translating a throwing accessor into {@link ProjectConfigParseError}.
 * Each property is read exactly once through this helper, so a getter can't answer a shape check
 * with one value and the actual read with another.
 */
function readEnvelopeProperty(container: Record<string, unknown>, key: string): unknown {
  try {
    return container[key];
  } catch (cause) {
    throw new ProjectConfigParseError({
      message: `reading envelope property "${key}" threw — raw API input must be plain parsed JSON`,
      cause,
      reason: "caller_misuse",
    });
  }
}

/**
 * An envelope carrying an explicit `type` must be `"project_config"`, so a mixed-up response for
 * another resource fails loudly instead of partially mapping. An absent `type` is tolerated.
 */
function assertProjectConfigResourceType(envelope: Record<string, unknown>): void {
  if (!Object.hasOwn(envelope, "type")) {
    return;
  }
  const resourceType = readEnvelopeProperty(envelope, "type");
  if (resourceType !== "project_config") {
    // JSON.stringify throws on a bigint discriminator, so render non-strings separately.
    const rendered =
      typeof resourceType === "string"
        ? JSON.stringify(resourceType)
        : nonObjectDescription(resourceType);
    throw envelopeError(`type is ${rendered}, expected "project_config"`);
  }
}

function nonObjectDescription(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return typeof value;
}

function envelopeError(detail: string): ProjectConfigParseError {
  const message = `malformed envelope — ${detail}`;
  return new ProjectConfigParseError({
    message: formatProjectConfigParseErrorMessage(message),
    cause: new Error(message),
    suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
  });
}

// Sync decode is fine here: this is an explicitly synchronous boundary, and the schema is
// service-free.
const decodeApiAttributes = Schema.decodeUnknownSync(ProjectConfigApiAttributesSchema);

/**
 * Builds the `message`/`apiPath`/`detail` triple for a schema decode failure. `apiPath` is the
 * first issue's path (stringified), `message` its summary, and `detail` the full multi-issue
 * rendering. An empty issue path (the failure is at the attributes root) normalizes to `undefined`,
 * matching {@link ProjectConfigParseError}'s own `apiPath` contract.
 */
function schemaDecodeFailureMessage(cause: unknown): {
  readonly message: string;
  readonly apiPath: ReadonlyArray<string> | undefined;
  readonly detail: string | undefined;
} {
  if (!Schema.isSchemaError(cause)) {
    return {
      message: formatProjectConfigParseErrorMessage(String(cause)),
      apiPath: undefined,
      detail: undefined,
    };
  }
  const { issues } = SchemaIssue.makeFormatterStandardSchemaV1()(cause.issue);
  const [firstIssue] = issues;
  // A path entry may be a bare `PropertyKey` or a `{ key: PropertyKey }` segment object per spec.
  const rawApiPath = firstIssue?.path?.map((segment) =>
    String(typeof segment === "object" ? segment.key : segment),
  );
  const apiPath = rawApiPath !== undefined && rawApiPath.length > 0 ? rawApiPath : undefined;
  const summary = firstIssue?.message ?? cause.message;
  const detail = SchemaIssue.makeFormatterDefault()(cause.issue);
  return {
    message: formatProjectConfigParseErrorMessage(summary, apiPath),
    apiPath,
    detail,
  };
}

function decodeAttributes(rawAttributes: Record<string, unknown>): ProjectConfigApiAttributes {
  try {
    return decodeApiAttributes(rawAttributes);
  } catch (cause) {
    const { message, apiPath, detail } = schemaDecodeFailureMessage(cause);
    throw new ProjectConfigParseError({
      message,
      apiPath,
      cause,
      detail,
      suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
    });
  }
}

/** Reads `path` off `root`, descending through plain objects; `undefined` at any missing/non-object step. */
function readPath(root: unknown, path: ReadonlyArray<string>): unknown {
  let current = root;
  for (const segment of path) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/** Writes `value` at `path` under `root`, creating intermediate plain objects as needed via `setOwnProperty`. */
function writePath(
  root: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: unknown,
): void {
  const [head, ...rest] = path;
  if (head === undefined) {
    return;
  }
  if (rest.length === 0) {
    setOwnProperty(root, head, value);
    return;
  }
  const existing = root[head];
  const next = isObject(existing) ? existing : {};
  if (next !== existing) {
    setOwnProperty(root, head, next);
  }
  writePath(next, rest, value);
}

/**
 * Walks {@link projectConfigMappingRows} against `decodedAttributes` and writes every surviving
 * mapped value into `output`. A row whose value is `undefined` is skipped; one whose value is
 * `null` is skipped unless it declares a `transform`. `isSecret` rows are never emitted — the API
 * only ever reports an HMAC digest for them.
 */
function applyMappingRows(
  decodedAttributes: ProjectConfigApiAttributes,
  output: Record<string, unknown>,
): void {
  for (const row of projectConfigMappingRows) {
    if (row.isSecret) {
      // Never emitted, but a present non-string is still a malformed response that must not
      // vanish silently from `unmappedApiFields`.
      const secretValue = readPath(decodedAttributes, row.apiPath);
      if (secretValue !== undefined && secretValue !== null) {
        expectString(secretValue, row.apiPath);
      }
      continue;
    }

    const rawValue = readPath(decodedAttributes, row.apiPath);
    if (rawValue === undefined) {
      // Still run when a sibling path is present, even with the anchor absent, so a malformed
      // sibling doesn't silently vanish.
      const siblingPresent = row.alsoConsumes?.some(
        (alsoPath) => readPath(decodedAttributes, alsoPath) !== undefined,
      );
      if (siblingPresent !== true) {
        continue;
      }
    }
    if (rawValue === null && row.transform === undefined) {
      continue;
    }

    const mapped =
      row.transform === undefined ? rawValue : row.transform(rawValue, decodedAttributes);
    if (mapped === undefined) {
      continue;
    }

    writePath(output, row.configPath, mapped);
  }

  // Orphan secret paths get the same present-non-null validation as `isSecret` rows above, so a
  // malformed value doesn't vanish from `unmappedApiFields` unvalidated.
  for (const secretPath of unmappedSecretApiPaths) {
    const secretValue = readPath(decodedAttributes, secretPath);
    if (secretValue !== undefined && secretValue !== null) {
      expectString(secretValue, secretPath);
    }
  }
}

/**
 * Depth bound for {@link walkUnmapped} and the raw-attributes validation walk, so a
 * pathologically deep or cyclic response fails as a typed error instead of overflowing the call
 * stack. A self-referential object has no finite depth, so this also catches cycles without a
 * separate visited-set.
 */
const MAX_UNMAPPED_WALK_DEPTH = 64;

/**
 * Total node visits the raw-attributes validation walk tolerates before declaring the structure
 * pathological. A real response holds a few hundred nodes; this bound catches a shared-reference
 * DAG (a depth-bounded structure that still explodes combinatorially through repeated visits) from
 * a programmatic `attachApiResponse` caller.
 */
const MAX_RAW_ATTRIBUTES_NODE_VISITS = 100_000;

function assertRawAttributesDepthWithinBound(
  value: unknown,
  depth = 0,
  visits: { count: number } = { count: 0 },
  // Via fromApiProjectConfig a pathological structure is a platform-response problem; via
  // attachApiResponse it's the caller's own data, so it must not be reported as an external
  // failure.
  reason: "api_response" | "caller_misuse" = "api_response",
): void {
  if (depth > MAX_UNMAPPED_WALK_DEPTH) {
    const detail = `pathological nesting: exceeded ${MAX_UNMAPPED_WALK_DEPTH} levels while validating the raw API response`;
    throw new ProjectConfigParseError({
      message: reason === "caller_misuse" ? detail : formatProjectConfigParseErrorMessage(detail),
      cause: new Error(detail),
      ...(reason === "caller_misuse"
        ? { reason }
        : { suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION }),
    });
  }
  // Bigint, undefined, and NaN have no JSON spelling and would break JSON.stringify on an
  // `unmappedApiFields` report, so they're rejected as caller input. ±Infinity is tolerated
  // instead — `JSON.parse` can legitimately produce it — and `walkUnmapped` renders it as `null`.
  if (
    typeof value === "bigint" ||
    value === undefined ||
    (typeof value === "number" && Number.isNaN(value))
  ) {
    throw new ProjectConfigParseError({
      message:
        "raw attributes hold a non-JSON primitive (a bigint, undefined, or NaN) — raw attributes must be plain parsed JSON",
      cause: new Error(`non-JSON primitive at depth ${depth}`),
      reason: "caller_misuse",
    });
  }
  visits.count += 1;
  if (visits.count > MAX_RAW_ATTRIBUTES_NODE_VISITS) {
    const detail = `pathological structure: exceeded ${MAX_RAW_ATTRIBUTES_NODE_VISITS} node visits while validating the raw API response`;
    throw new ProjectConfigParseError({
      message: reason === "caller_misuse" ? detail : formatProjectConfigParseErrorMessage(detail),
      cause: new Error(detail),
      ...(reason === "caller_misuse"
        ? { reason }
        : { suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION }),
    });
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      assertRawAttributesDepthWithinBound(child, depth + 1, visits, reason);
    }
    return;
  }
  if (isObject(value)) {
    // Only plain objects pass: Object.freeze only freezes a Map/Set/Date's wrapper, leaving its
    // mutators still working, which would punch a mutable hole through the deep-frozen metadata.
    // The brand check (not just prototype identity) also accepts a plain object parsed in another
    // realm.
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== Object.prototype &&
      prototype !== null &&
      Object.prototype.toString.call(value) !== "[object Object]"
    ) {
      throw new ProjectConfigParseError({
        message:
          "raw attributes hold a non-plain object (e.g. a Map, Set, Date, or typed array) — raw attributes must be plain parsed JSON",
        cause: new Error(`non-plain object at depth ${depth}`),
        reason: "caller_misuse",
      });
    }
    for (const child of Object.values(value)) {
      assertRawAttributesDepthWithinBound(child, depth + 1, visits, reason);
    }
  }
}

/**
 * Wraps `structuredClone` for {@link attachFrozenApiResponse}, translating its untyped
 * `DOMException` (thrown on a function/symbol-valued attribute) into {@link ProjectConfigParseError}.
 */
function cloneRawAttributes(
  rawAttributes: Record<string, unknown>,
  reason: "api_response" | "caller_misuse" = "api_response",
): Record<string, unknown> {
  try {
    return structuredClone(rawAttributes);
  } catch (cause) {
    // structuredClone also throws on sufficiently deep plain JSON, which a platform response can
    // genuinely be, so provenance follows the call site rather than assuming misuse.
    const detail =
      "raw attributes hold a value structuredClone cannot copy (a non-JSON value, or pathologically deep nesting)";
    throw new ProjectConfigParseError({
      message: reason === "caller_misuse" ? detail : formatProjectConfigParseErrorMessage(detail),
      cause,
      ...(reason === "caller_misuse"
        ? { reason }
        : { suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION }),
    });
  }
}

/**
 * Attaches a deep-cloned, deep-frozen copy of `rawAttributes` to a fresh shallow copy of
 * `enumerableProps` as a non-enumerable `_apiResponse`. Shared by {@link fromApiProjectConfig} and
 * {@link attachApiResponse} so both go through one clone+freeze path; cloning means neither this
 * package nor a caller can mutate the attached raw attributes afterward.
 */
function attachFrozenApiResponse<T extends Record<string, unknown>>(
  enumerableProps: T,
  rawAttributes: Record<string, unknown>,
  reason: "api_response" | "caller_misuse" = "api_response",
): T {
  // Clone first, then validate the clone: validating live input first would leave a
  // time-of-check/time-of-use gap for a getter that answers differently on each read.
  const cloned = cloneRawAttributes(rawAttributes, reason);
  assertRawAttributesDepthWithinBound(cloned, 0, undefined, reason);
  return attachOwnedSnapshot(enumerableProps, cloned);
}

/**
 * Maps a Management API v2 project-config response into a {@link ProjectConfig}: unwraps whichever
 * envelope shape `input` is, decodes the attributes leniently (an API-ahead-of-package field never
 * fails decode, only a genuinely malformed mapped field does), walks the mapping registry
 * (`./registry.ts`) to populate the typed sections, and attaches a deep-frozen copy of the raw
 * attributes as a non-enumerable `_apiResponse` so {@link unmappedApiFields} can still reach
 * whatever the registry didn't map.
 *
 * Not a verbatim projection of the response (ADR 0021): a `null` on a gating boolean canonicalizes
 * to `enabled: false`, {@link applyDisabledSentinels} pruning runs here too, and an out-of-domain
 * value on a mapped field throws rather than canonicalizing to a wrong value — so an API-sourced
 * and a document-sourced `ProjectConfig` compare like for like.
 *
 * @throws {@link ProjectConfigParseError} if `input` isn't an object, the envelope is malformed, or a value fails to decode or map.
 */
export function fromApiProjectConfig(input: unknown): ProjectConfig;
// Untyped for the same reason as `fromConfigDocument`: the mapping walk builds its result
// dynamically, which TypeScript can't verify reconstructs a `ProjectConfig`.
export function fromApiProjectConfig(input: unknown): unknown {
  const rawAttributes = unwrapApiResponse(input);
  // One inert snapshot for everything: clone first so decode, mapping, and the attached metadata
  // all read the same data, then bound its depth before schema decoding, since a pathologically
  // deep value would otherwise overflow the decode itself with a raw RangeError.
  const snapshot = cloneRawAttributes(rawAttributes);
  assertRawAttributesDepthWithinBound(snapshot);
  const decodedAttributes = decodeAttributes(snapshot);

  const output: Record<string, unknown> = {};
  applyMappingRows(decodedAttributes, output);
  applyDisabledSentinels(output);

  // Already validated and exclusively owned here, so freeze and attach directly — no second pass.
  return attachOwnedSnapshot(output, snapshot);
}

/** Freezes and attaches an already-validated, exclusively-owned snapshot — the tail of {@link attachFrozenApiResponse} without its clone/validate steps. */
function attachOwnedSnapshot<T extends Record<string, unknown>>(
  enumerableProps: T,
  snapshot: Record<string, unknown>,
): T {
  let frozen: Record<string, unknown>;
  try {
    frozen = deepFreeze(snapshot);
  } catch (cause) {
    throw new ProjectConfigParseError({
      message:
        "raw attributes hold a value that cannot be frozen (e.g. a typed array) — raw attributes must be plain parsed JSON",
      cause,
      reason: "caller_misuse",
    });
  }
  // A getter on a caller-supplied props object (attachApiResponse) could otherwise leak a raw
  // throw here; the API arm's own props are always plain data.
  let result: T;
  try {
    result = { ...enumerableProps };
  } catch (cause) {
    throw new ProjectConfigParseError({
      message:
        "reading the config's enumerable properties threw — attachApiResponse configs must be plain data, not accessor-backed",
      cause,
      reason: "caller_misuse",
    });
  }
  Object.defineProperty(result, "_apiResponse", {
    value: frozen,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result;
}

/**
 * Re-attaches `_apiResponse` to `config` after a spread, `structuredClone`, or state-store
 * round-trip drops it, since those operations are blind to non-enumerable properties. Returns a
 * new object — a shallow copy of `config` plus `rawAttributes` attached via the same
 * clone-and-freeze path {@link fromApiProjectConfig} uses — and never mutates `config` in place.
 *
 * @throws {@link ProjectConfigParseError} if `config` is not an object.
 */
export function attachApiResponse(
  config: ProjectConfig,
  rawAttributes: Record<string, unknown>,
): ProjectConfig;
// Untyped for the same reason as the other two normalizers above.
export function attachApiResponse(
  config: unknown,
  rawAttributes: Record<string, unknown>,
): unknown {
  if (!isObject(config)) {
    throw callerMisuseError(
      `attachApiResponse "config" must be an object, got ${nonObjectDescription(config)}`,
    );
  }
  if (!isObject(rawAttributes)) {
    throw callerMisuseError(
      `attachApiResponse "rawAttributes" must be an object, got ${nonObjectDescription(rawAttributes)}`,
    );
  }
  return attachFrozenApiResponse(config, rawAttributes, "caller_misuse");
}

/**
 * Either operand `toProjectConfig` accepts: a local {@link EffectiveConfig} or
 * {@link CliConfigWithRawPresence} pair to project down to the hosted subset, or a raw,
 * not-yet-decoded Management API v2 project-config response to map.
 */
export type ToProjectConfigSource =
  | { readonly cliConfig: EffectiveConfig | CliConfigWithRawPresence }
  | { readonly apiResponse: unknown };

function hasApiResponse(
  source: ToProjectConfigSource,
): source is { readonly apiResponse: unknown } {
  return Object.hasOwn(source, "apiResponse");
}

function hasCliConfig(
  source: ToProjectConfigSource,
): source is { readonly cliConfig: EffectiveConfig | CliConfigWithRawPresence } {
  return Object.hasOwn(source, "cliConfig");
}

/**
 * Builds a caller-misuse error: a programming error in the consumer, not a malformed platform
 * response, so the message omits the "Management API response" framing and upgrade suggestion.
 */
function callerMisuseError(detail: string): ProjectConfigParseError {
  return new ProjectConfigParseError({
    message: detail,
    cause: new Error(detail),
    reason: "caller_misuse",
  });
}

/**
 * Thin dispatcher over the two normalizers above: routes to {@link fromApiProjectConfig} when
 * `source` carries an own `apiResponse` property, otherwise to {@link fromConfigDocument} for an
 * own `cliConfig` property.
 *
 * @throws {@link ProjectConfigParseError} if `source` carries neither key or both.
 */
export function toProjectConfig(source: ToProjectConfigSource): ProjectConfig {
  // Guard before the own-property checks so a non-object caller input surfaces as the documented
  // typed error, not a native TypeError from Object.hasOwn.
  if (!isObject(source)) {
    throw callerMisuseError(
      `toProjectConfig source must be an object carrying exactly one of "cliConfig" or "apiResponse", got ${nonObjectDescription(source)}`,
    );
  }
  if (hasApiResponse(source)) {
    if (hasCliConfig(source)) {
      throw callerMisuseError(
        'toProjectConfig source must carry exactly one of an own "cliConfig" or "apiResponse" property, got both',
      );
    }
    return fromApiProjectConfig(readSourceProperty(() => source.apiResponse, "apiResponse"));
  }
  if (hasCliConfig(source)) {
    return fromConfigDocument(readSourceProperty(() => source.cliConfig, "cliConfig"));
  }
  throw callerMisuseError(
    'toProjectConfig source must carry exactly one of an own "cliConfig" or "apiResponse" property, got neither',
  );
}

/** Reads the dispatcher's selected source property, translating a throwing accessor into {@link ProjectConfigParseError}. */
function readSourceProperty<T>(read: () => T, key: string): T {
  try {
    return read();
  } catch (cause) {
    throw new ProjectConfigParseError({
      message: `reading source property "${key}" threw — toProjectConfig sources must be plain data, not accessor-backed`,
      cause,
      reason: "caller_misuse",
    });
  }
}

function pathKey(path: ReadonlyArray<string>): string {
  // JSON-encoded rather than joined, since a raw API key can contain any candidate separator.
  return JSON.stringify(path);
}

/**
 * Every API path this registry version "knows about" — a row's own `apiPath`, everything its
 * `alsoConsumes` names, and every `unmappedSecretApiPaths` entry. "Consumed" means known to this
 * registry version, not mapped on this run: a sibling stays suppressed even when its anchor row's
 * value was absent, since it would otherwise flip between "unmapped" and mapped from run to run.
 * Consumption is subtree-wide, not leaf-only, so a platform-added key nested inside a mapped
 * container's own structure is never itemized either — `_apiResponse` still carries it verbatim.
 */
const consumedApiPathKeys: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  for (const row of projectConfigMappingRows) {
    keys.add(pathKey(row.apiPath));
    for (const alsoPath of row.alsoConsumes ?? []) {
      keys.add(pathKey(alsoPath));
    }
  }
  for (const secretPath of unmappedSecretApiPaths) {
    keys.add(pathKey(secretPath));
  }
  return keys;
})();

/**
 * Every proper prefix of a consumed path, plus the six top-level sections the mirror schema
 * declares — the containers this registry version already "knows". {@link walkUnmapped} prunes a
 * known container that is empty in the raw response, while an empty object at an unknown path
 * survives as drift signal — a newly introduced, not-yet-populated API section.
 */
const knownApiContainerKeys: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  const addPrefixes = (path: ReadonlyArray<string>): void => {
    for (let length = 1; length < path.length; length++) {
      keys.add(pathKey(path.slice(0, length)));
    }
  };
  for (const row of projectConfigMappingRows) {
    addPrefixes(row.apiPath);
    for (const alsoPath of row.alsoConsumes ?? []) {
      addPrefixes(alsoPath);
    }
  }
  for (const secretPath of unmappedSecretApiPaths) {
    addPrefixes(secretPath);
  }
  for (const section of ["database", "pooler", "auth", "api", "realtime", "storage"]) {
    keys.add(pathKey([section]));
  }
  return keys;
})();

/**
 * Deep-sanitizes a non-finite number anywhere inside an unmapped array leaf into `null`, matching
 * `JSON.stringify`'s own collapse — an array is returned wholesale by `walkUnmapped`, so a
 * non-finite value hiding inside one would otherwise reach `unmappedApiFields` unsanitized.
 *
 * Returns the same reference, not a copy, when nothing needed sanitizing, so an all-finite array
 * stays a subtree of the deep-frozen `_apiResponse` rather than paying for a fresh copy.
 */
function sanitizeNonFiniteArrayLeaf(value: unknown, depth: number): unknown {
  if (depth > MAX_UNMAPPED_WALK_DEPTH) {
    const detail = `pathological nesting: exceeded ${MAX_UNMAPPED_WALK_DEPTH} levels while walking for unmapped fields`;
    throw new ProjectConfigParseError({
      message: formatProjectConfigParseErrorMessage(detail),
      cause: new Error(detail),
      suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
    });
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((element) => {
      const sanitized = sanitizeNonFiniteArrayLeaf(element, depth + 1);
      if (sanitized !== element) {
        changed = true;
      }
      return sanitized;
    });
    return changed ? mapped : value;
  }
  if (isObject(value)) {
    let changed = false;
    const mapped: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const sanitized = sanitizeNonFiniteArrayLeaf(child, depth + 1);
      if (sanitized !== child) {
        changed = true;
      }
      setOwnProperty(mapped, key, sanitized);
    }
    return changed ? mapped : value;
  }
  return value;
}

function walkUnmapped(value: unknown, path: ReadonlyArray<string>, depth = 0): unknown {
  if (depth > MAX_UNMAPPED_WALK_DEPTH) {
    const detail = `pathological nesting: exceeded ${MAX_UNMAPPED_WALK_DEPTH} levels while walking for unmapped fields`;
    throw new ProjectConfigParseError({
      message: formatProjectConfigParseErrorMessage(detail),
      cause: new Error(detail),
      suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
    });
  }
  if (consumedApiPathKeys.has(pathKey(path))) {
    return undefined;
  }
  // A tolerated ±Infinity leaf has no JSON spelling; collapse it to `null`, matching JSON.stringify.
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  // Arrays are returned wholesale, never walked element-by-element, so sanitize non-finite
  // numbers inside them separately.
  if (Array.isArray(value)) {
    return sanitizeNonFiniteArrayLeaf(value, depth);
  }
  if (!isObject(value)) {
    return value;
  }
  // An empty object at an unknown path is itself drift signal (a newly introduced section); an
  // empty known container is pruned, since it has nothing unknown to report.
  if (Object.keys(value).length === 0) {
    return knownApiContainerKeys.has(pathKey(path)) ? undefined : {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const mapped = walkUnmapped(child, [...path, key], depth + 1);
    if (mapped !== undefined) {
      setOwnProperty(result, key, mapped);
    }
  }

  return Object.keys(result).length === 0 ? undefined : result;
}

/**
 * The subtree of `config._apiResponse` that {@link projectConfigMappingRows} does not map —
 * `{}` when `config` carries no `_apiResponse` at all, which does not mean "fully mapped".
 * Registry-derived, not a hand-maintained field list: a path is "mapped" when some row's `apiPath`
 * or `alsoConsumes` names it. Empty objects are pruned, so a fully-mapped subtree never shows up
 * as `{}` noise.
 *
 * Reports at registry `apiPath` granularity, not full recursive fidelity: a key nested inside a
 * consumed subtree is not itemized here either, though `_apiResponse` still carries it verbatim
 * for a consumer that needs full fidelity.
 *
 * The result can include the HMAC digest the API reports for a secret-typed key this package
 * doesn't know about yet. Callers must not render this result blindly.
 *
 * @throws {@link ProjectConfigParseError} if `_apiResponse` is nested more than 64 levels deep, or `config` is not a plain object.
 */
export function unmappedApiFields(config: ProjectConfig): {
  readonly [key: string]: ReadonlyJsonValue;
};
// Untyped because the report's containers are rebuilt fresh while its leaf arrays/objects are
// shared by reference with the deep-frozen `_apiResponse`; a mutable return type would compile
// a `.push(...)` that throws at runtime.
export function unmappedApiFields(config: unknown): unknown {
  // A non-object operand must surface as the documented typed failure, not a raw TypeError.
  if (!isObject(config)) {
    throw callerMisuseError(
      `unmappedApiFields config must be an object, got ${nonObjectDescription(config)}`,
    );
  }
  const rawAttributes = readApiResponseProperty(config);
  if (rawAttributes === undefined) {
    return {};
  }
  const result = walkUnmapped(rawAttributes, []);
  return isObject(result) ? result : {};
}

/** Reads `config._apiResponse`, translating a throwing accessor into {@link ProjectConfigParseError}. */
function readApiResponseProperty(config: Record<string, unknown>): unknown {
  try {
    return config["_apiResponse"];
  } catch (cause) {
    throw new ProjectConfigParseError({
      message:
        'reading "_apiResponse" threw — unmappedApiFields operands must be plain data, not accessor-backed',
      cause,
      reason: "caller_misuse",
    });
  }
}

/**
 * The deduped `configPath`s of every non-`isSecret` row in {@link projectConfigMappingRows} — the
 * fields `fromApiProjectConfig` can actually speak for. Exists so a diff consumer never
 * hand-maintains an equivalent field list; excludes secret rows and every field with no row at all.
 *
 * Only remedies the whole-section granularity gap, not the finer per-path gap: a path can be a
 * member of this list and still fabricate drift against a document operand that never declared its
 * containing sub-section at all. A caller doing that comparison must additionally intersect with
 * what the document side actually declared.
 */
export const comparableProjectConfigPaths: ReadonlyArray<ReadonlyArray<string>> = (() => {
  const seenKeys = new Set<string>();
  const paths: Array<ReadonlyArray<string>> = [];
  for (const row of projectConfigMappingRows) {
    if (row.isSecret) {
      continue;
    }
    const key = pathKey(row.configPath);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    paths.push(row.configPath);
  }
  return paths;
})();

const comparableProjectConfigPathKeys: ReadonlySet<string> = new Set(
  comparableProjectConfigPaths.map(pathKey),
);

/**
 * Whether `path` is a member of {@link comparableProjectConfigPaths}, or a descendant of one (a
 * row mapping a container, e.g. a record, makes each of its leaves comparable too). A bare prefix
 * of a mapped path is not comparable — it names a section, not a mapped value.
 */
export function isComparableProjectConfigPath(path: ReadonlyArray<string>): boolean {
  for (let length = path.length; length >= 1; length--) {
    if (comparableProjectConfigPathKeys.has(pathKey(path.slice(0, length)))) {
      return true;
    }
  }
  return false;
}

/**
 * Deduped `configPath`s of every `dualScope` row in {@link projectConfigMappingRows} — fields with
 * a legitimate different correct value for the local stack than the hosted project. `config pull`
 * uses this list to warn before overwriting one of these fields at the config root, since that
 * would reconfigure `supabase start` rather than record the hosted project's setting; a write into
 * a `[remotes.*]` block is unaffected.
 */
export const dualScopeProjectConfigPaths: ReadonlyArray<ReadonlyArray<string>> = (() => {
  const seenKeys = new Set<string>();
  const paths: Array<ReadonlyArray<string>> = [];
  for (const row of projectConfigMappingRows) {
    if (row.dualScope !== true) {
      continue;
    }
    const key = pathKey(row.configPath);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    paths.push(row.configPath);
  }
  return paths;
})();
