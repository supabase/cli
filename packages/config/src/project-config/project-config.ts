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
import { unmappedSecretApiPaths } from "./registry-auth.ts";
import { expectString } from "./registry-row.ts";
import { projectConfigMappingRows } from "./registry.ts";

const HOSTED_SECTION_KEYS = [
  "api",
  "auth",
  "db",
  "realtime",
  "storage",
  "workers",
  "experimental",
] as const;

/** The seven keys {@link ProjectConfig} can carry, derived once so the type and the runtime walk below can't drift apart. */
type HostedSectionKey = (typeof HOSTED_SECTION_KEYS)[number];

/**
 * A deeply-readonly JSON value — the shape of everything under
 * `_apiResponse`, which holds (a clone of) a parsed Management API JSON
 * payload and is recursively frozen at attach time. Typed recursively
 * readonly so no narrowing path reaches a mutable view: with plain `unknown`
 * values, `Array.isArray(...)` would narrow to a mutable array whose
 * `.push` compiles and then throws against the frozen runtime value. (A
 * programmatic `attachApiResponse` caller can technically hand over
 * non-JSON structured-cloneable values — Dates, Maps; those step outside
 * this type by their own choice, exactly like any other consumer-side
 * assertion.) One narrowing caveat no user-space type can close: the lib's
 * own `Array.isArray` guard is typed `arg is any[]`, so narrowing through it
 * yields a MUTABLE array view (microsoft/TypeScript#17002) whose `.push`
 * compiles and then throws against the frozen value — narrow with a
 * readonly-preserving guard (`(v): v is ReadonlyArray<ReadonlyJsonValue> =>
 * Array.isArray(v)`) instead.
 */
export type ReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<ReadonlyJsonValue>
  | { readonly [key: string]: ReadonlyJsonValue };

/**
 * The hosted-project subset of {@link CliConfig}: the sections a Management
 * API project-config response can speak for (`api`, `auth`, `db`,
 * `realtime`, `storage`, `workers`, `experimental`) — never the local-only
 * sections (`studio`, service ports, `edge_runtime`, `analytics`,
 * `[remotes.*]`, …) that only make sense for a checkout on disk
 * (`docs/cli-config-loading.md`'s vocabulary).
 *
 * Deliberately sparse (`DeepPartial`), not a fully-materialized `CliConfig`
 * with schema defaults filled in: an API response never mentions a section
 * or field it doesn't manage, and a `ProjectConfig` that flooded in schema
 * defaults for everything it didn't report would fabricate drift against a
 * local document that genuinely differs only where the API actually speaks
 * (CLI-2230's design rule). Sparseness is also what makes a `ProjectConfig`
 * usable as an operand of `subtractCliConfig`/`omitDefaultValues`
 * (`../sparse.ts`): those helpers take an {@link EffectiveConfig}, and a
 * `ProjectConfig` (minus `_apiResponse`, which those walks never see — see
 * below) is structurally assignable to it, since `EffectiveConfig` is
 * `DeepPartial<Omit<CliConfig, "remotes">>` and every key `ProjectConfig`
 * can carry is one of `CliConfig`'s non-`remotes` keys.
 *
 * `_apiResponse` follows ADR 0019: present only on a value built by
 * {@link fromApiProjectConfig} (never on one built by
 * {@link fromConfigDocument}), holding a deep-cloned, deep-frozen copy of the
 * raw, pre-mapping `data.attributes` object (frozen/cloned rather than
 * aliasing the caller's object: neither this package nor a caller can
 * accidentally mutate it after the fact). It is attached as a non-enumerable
 * property at runtime (rule 1), so it is invisible to every *serializer* —
 * `JSON.stringify`, object spread, `Object.assign`, `structuredClone` — and
 * to the structural walks in `../sparse.ts`, and is therefore never
 * persisted to a config file. Invisible to serializers is not invisible to
 * every possible inspection, though: a debug inspector that deliberately
 * shows non-enumerable own properties (e.g. Bun's `console.log`) still
 * prints it. Never log an API-sourced `ProjectConfig` directly — the raw
 * attributes can include an HMAC digest of a secret value. A caller that
 * loses `_apiResponse` across a spread/`structuredClone`/state-store
 * round-trip can re-attach it via {@link attachApiResponse}.
 *
 * The seven hosted-section keys above are a vocabulary-level ceiling, not a
 * per-field guarantee: they name every section a project-config response
 * *could* speak for, not how much of each section a given operand actually
 * does. `fromConfigDocument`'s operand (a `CliConfig`/`EffectiveConfig`) can
 * genuinely carry any field in any of the seven. `fromApiProjectConfig`'s
 * operand speaks for far fewer — `realtime` maps zero rows today (every field
 * is local dev-server tuning with no hosted counterpart, `./registry.ts`'s
 * comment on `realtime`), and `workers`/`experimental` have no v2
 * project-config API counterpart at all, so an API-sourced `ProjectConfig`
 * never carries those two keys regardless of what the remote project has
 * configured. A comparison consumer (CLI-2156) must restrict its comparison
 * to the fields both operands actually speak for, never treat one operand's
 * whole-section presence/absence as drift against the other's — that
 * granularity gap is not only whole-section: several record-entry and
 * optional-substruct fields the registry maps *unconditionally* (every
 * mailer template/notification row, `email.smtp.enabled`, every
 * `db.settings.*` row, `sessions.timebox`/`inactivity_timeout`,
 * `captcha.enabled`, …) appear on an API-sourced `ProjectConfig` even when a
 * local document never declared that sub-section at all, since the mapping
 * has no "the local document is silent here" signal to withhold on. Use
 * {@link comparableProjectConfigPaths}/{@link isComparableProjectConfigPath}
 * to restrict a comparison to exactly the fields `fromApiProjectConfig` can
 * actually speak for, rather than hand-maintaining an equivalent field list.
 */
export type ProjectConfig = DeepPartial<Pick<CliConfig, HostedSectionKey>> & {
  // Readonly, recursively: the runtime value is deep-frozen
  // (attachFrozenApiResponse), so any compile-permitted mutation — a
  // top-level assignment or a `.push` on a narrowed nested array — would
  // throw a TypeError in this ESM package.
  readonly _apiResponse?: { readonly [key: string]: ReadonlyJsonValue };
};

/**
 * Deep-copies `value` (a hosted-section subtree rooted at `path`) at the
 * OBJECT level, dropping every leaf whose full path matches an `x-secret`
 * schema annotation (CLI-2230's secret-omission finding): `fromConfigDocument`'s
 * input is a *decoded* `CliConfig`/`EffectiveConfig`, where `secret()`-annotated fields
 * (`../lib/env.ts`) hold plaintext or an unresolved `env(VAR)` literal, never
 * a `Redacted` wrapper (decode never redacts — only
 * `resolveCliConfigValue`/`resolveCliConfigSubtree`, `../project.ts`, do,
 * and only post-decode). Sharing the input subtree by reference, as this
 * function's predecessor did, would carry that plaintext straight onto the
 * returned `ProjectConfig` — and since `fromApiProjectConfig` never reports
 * an `x-secret` field's value (ADR 0019 rule 5, the API only ever returns an
 * HMAC digest), a document-sourced `ProjectConfig` that kept its secrets
 * would register as drift against the API-sourced side for every secret
 * field, which is worse than useless for a diff consumer. Arrays are copied
 * recursively, element by element — a hosted array can hold objects (e.g.
 * `experimental.inspect.rules`), and a merely-sliced container would alias
 * them back to the (possibly frozen) input, breaking the fresh-copy
 * contract. No `x-secret` leaf in `CliConfigSchema` sits inside an array, so
 * the secret-path walk carries through elements as a no-op; empty-record
 * *elements* are preserved (the empty-container prune applies only to record
 * children — arrays compare wholesale in `../sparse.ts`, so their contents
 * must survive verbatim).
 *
 * A child that stripping leaves as (or that already was) an empty plain
 * object is pruned from `result` entirely, rather than kept as `{}` litter:
 * a genuinely-empty container carries no comparable information either way
 * (nothing for a diff consumer to compare against), and left in place it is
 * exactly the kind of key `subtractCliConfig` keeps verbatim forever, since
 * a baseline that never declared that key at all treats `{}` the same as
 * any other "present" value (CLI-2230's secret-strip empty-container
 * finding). Pruning recurses back up through {@link fromConfigDocument}'s
 * own per-section loop too, so a hosted section that turns out to contain
 * nothing but secrets disappears from the projection outright instead of
 * surviving as an empty section. Arrays are exempt — `[]` is a meaningful,
 * explicit value (e.g. "no redirect URLs"), never litter from secret
 * stripping.
 */
function copyHostedValueWithoutSecrets(value: unknown, path: ReadonlyArray<string>): unknown {
  if (Array.isArray(value)) {
    // Elements are copied recursively too — a hosted array can hold objects
    // (e.g. `experimental.inspect.rules`), and a merely-sliced container
    // would alias them back to the (possibly frozen) input, breaking the
    // fresh-copy contract. The path passes through unchanged: no x-secret
    // pattern descends through an array in the hosted schema today, and
    // empty-record *elements* are preserved (the empty-container prune below
    // applies only to record children — arrays compare wholesale, so their
    // contents must survive verbatim).
    return value.map((element) => copyHostedValueWithoutSecrets(element, path));
  }
  if (isObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      if (isSecretPath(childPath)) {
        continue;
      }
      const copied = copyHostedValueWithoutSecrets(child, childPath);
      // Prune only containers this copy itself EMPTIED (a secret-stripped
      // subtree, possibly cascading upward) — never one that was empty in the
      // input. An originally-empty object can be data: a record entry's value
      // is an empty struct by schema design (`storage.analytics.buckets`,
      // `storage.vector.buckets`), so `{ buckets: { reports: {} } }` must
      // keep its entry — the KEY is the information.
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
 * Applies every registry row's `normalizeDocument` (`./registry-row.ts`) to
 * `output` in place, at `row.configPath`, after the secret-omitting copy
 * above has already run — CLI-2230's duration/byte-size finding. A row
 * without `normalizeDocument` is untouched; a row whose `configPath` is
 * absent from `output` is skipped (nothing to normalize); otherwise the
 * leaf is replaced with the row's canonicalized value.
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
    writePath(output, row.configPath, row.normalizeDocument(current));
  }
}

/**
 * Projects a {@link CliConfig} document (or any {@link EffectiveConfig}
 * operand — a full `CliConfig` is one) down to its hosted-section subset.
 * Copies each hosted section deeply and only when own-present on `config`,
 * omitting every `x-secret` leaf ({@link copyHostedValueWithoutSecrets}) and
 * canonicalizing every field a registry row's `normalizeDocument` covers
 * ({@link applyDocumentNormalizations}) — parity with
 * {@link fromApiProjectConfig}'s own secret omission and canonical
 * duration/byte-size spellings, so the same logical hosted config compares
 * equal regardless of which side produced it, and so this function never
 * leaks a document's plaintext secrets onto a value that will sit next to
 * an API-sourced `ProjectConfig` in a diff. The returned value is always a
 * fresh copy — safe to call even when `config` is frozen (e.g.
 * {@link getDefaultCliConfig}'s memo). Never attaches `_apiResponse`; that
 * only happens in {@link fromApiProjectConfig}. Throws
 * {@link ProjectConfigParseError} if a value at a normalized path is
 * malformed in a way `normalizeDocument` cannot tolerate — in practice this
 * should not happen, since every `normalizeDocument` implementation returns
 * its input verbatim rather than throwing.
 */
export function fromConfigDocument(config: EffectiveConfig): ProjectConfig;
// The implementation signature stays untyped for the same reason as
// `subtractCliConfig` (`../sparse.ts`): TypeScript cannot verify that a
// structural pick over dynamically-iterated keys reconstructs a
// `ProjectConfig`; the overload above is the contract, pinned by the unit
// tests.
export function fromConfigDocument(config: EffectiveConfig): unknown {
  // A JavaScript caller can hand this public normalizer null/undefined/an
  // array despite the compile-time type; guarding before Object.hasOwn keeps
  // the failure inside the documented typed-error contract (with the
  // caller-misuse reason) instead of a native TypeError or a silent `{}`.
  if (!isObject(config)) {
    throw callerMisuseError(
      `fromConfigDocument operand must be an object, got ${nonObjectDescription(config)}`,
    );
  }
  const result: Record<string, unknown> = {};
  for (const key of HOSTED_SECTION_KEYS) {
    if (Object.hasOwn(config, key)) {
      const section = config[key];
      const copied = copyHostedValueWithoutSecrets(section, [key]);
      // Same emptied-by-the-copy prune as `copyHostedValueWithoutSecrets`'s
      // own recursion, applied at the section boundary: a section that turns
      // out to contain nothing but secrets must disappear from the projection
      // entirely, while a section the document genuinely declared empty
      // survives as declared.
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
  applyDisabledSentinels(result);
  return result;
}

/**
 * Fields the legacy push does not manage while their section's toggle is off
 * — it writes only the disable sentinel for each of these (Data API: only
 * `db_schema: ""`, api.sync.ts:130-145; network restrictions: whole flow
 * skipped, db.sync.ts:148-150; SMTP: only `smtp_host: ""`,
 * auth.sync.ts:2384-2397; storage Iceberg/Vector: whole feature omitted,
 * storage.sync.ts:287-299; captcha provider/secret only when enabled,
 * :2315-2324; hook URI/secrets only when enabled, :2551-2565; SMS provider
 * credentials only for the selected provider, :2498-2539; whole Auth/Storage
 * sections gated on their own `enabled`, :1224-1226 / storage.sync.ts's
 * subset gating) — so projecting the (usually schema-filled or
 * platform-retained) siblings would fabricate drift between representations
 * of the same disabled state. Applied to BOTH normalizers' outputs: the
 * mapped shape is identical on the document and API arms, so one pass keeps
 * the two symmetric by construction.
 */
const DISABLED_SENTINEL_PRUNES: ReadonlyArray<{
  readonly containerPath: ReadonlyArray<string>;
  /** Keys to drop when `enabled === false`; absent = drop every key but `enabled`. */
  readonly dropKeys?: ReadonlyArray<string>;
}> = [
  // Top-level service toggles first — they subsume the section rules below.
  { containerPath: ["auth"] },
  { containerPath: ["storage"] },
  { containerPath: ["api"], dropKeys: ["schemas", "extra_search_path", "max_rows"] },
  {
    containerPath: ["db", "network_restrictions"],
    dropKeys: ["allowed_cidrs", "allowed_cidrs_v6"],
  },
  {
    containerPath: ["auth", "email", "smtp"],
    dropKeys: ["host", "port", "user", "pass", "admin_email", "sender_name"],
  },
  { containerPath: ["auth", "captcha"], dropKeys: ["provider", "secret"] },
  // No push precedent (the section postdates the legacy mappers) — gated for
  // family consistency: every other enabled-flagged container prunes its
  // unmanaged siblings, and a platform-retained authorization path behind a
  // disabled OAuth server is the same phantom-drift shape.
  {
    containerPath: ["auth", "oauth_server"],
    dropKeys: ["allow_dynamic_registration", "authorization_url_path"],
  },
  {
    containerPath: ["storage", "analytics"],
    dropKeys: ["max_namespaces", "max_tables", "max_catalogs"],
  },
  { containerPath: ["storage", "vector"], dropKeys: ["max_buckets", "max_indexes"] },
];

/** Record-shaped containers whose per-entry `enabled: false` keeps only the flag. */
const DISABLED_SENTINEL_ENTRY_SWEEPS: ReadonlyArray<{
  readonly containerPath: ReadonlyArray<string>;
  /** Restrict the sweep to these entry keys (a container mixing records and scalars). */
  readonly entryKeys?: ReadonlyArray<string>;
}> = [
  { containerPath: ["auth", "external"] },
  { containerPath: ["auth", "hook"] },
  {
    containerPath: ["auth", "sms"],
    entryKeys: ["twilio", "twilio_verify", "messagebird", "textlocal", "vonage"],
  },
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
  // Cross-section rule: the email rate limit is only managed while SMTP is
  // enabled (authToUpdateBody sends rate_limit_email_sent solely under
  // local.email.smtp.enabled, auth.sync.ts:2310-2313) — with SMTP absent or
  // disabled, a (default or platform-retained) value is unmanaged noise.
  const authSection = result["auth"];
  if (isObject(authSection)) {
    const email = authSection["email"];
    const smtp = isObject(email) ? email["smtp"] : undefined;
    const smtpEnabled = isObject(smtp) && smtp["enabled"] === true;
    const rateLimit = authSection["rate_limit"];
    if (!smtpEnabled && isObject(rateLimit)) {
      delete rateLimit["email_sent"];
      if (Object.keys(rateLimit).length === 0) {
        delete authSection["rate_limit"];
      }
      // This is the one sentinel that can empty its whole section (every
      // other rule keeps at least the `enabled` flag) — a section emptied by
      // pruning is unmanaged noise, unlike an originally-empty one.
      if (Object.keys(authSection).length === 0) {
        delete result["auth"];
      }
    }
  }
}

/**
 * Unwraps the three shapes a caller might hand `fromApiProjectConfig`: the
 * full envelope (`{data: {type, attributes}}`), the `data` object itself
 * (`{type, attributes}`), or bare `attributes`. Presence of an own `data` or
 * `attributes` key decides which shape was intended, and each of those two
 * shapes is then validated strictly: a malformed envelope (e.g. `{data:
 * {attributes: 5}}`) throws rather than silently falling through to "bare
 * attributes", which would map to an empty {@link ProjectConfig} — read by a
 * diff consumer as "the remote manages nothing", a confidently wrong result
 * for what is actually a decode failure. Only the *absence* of both an own
 * `data` and an own `attributes` key is treated as "this is bare attributes
 * already" — an API-ahead section literally named `data` or `attributes`
 * inside a real attributes object is deliberately foreclosed as a
 * possibility here, since a truncated or malformed envelope reaching this
 * function is far likelier than the platform ever naming a project-config
 * section either of those two words. This is the one documented trade
 * behind {@link ProjectConfigParseError}'s "unknown keys never cause this"
 * claim: an unknown key collides with envelope detection only when it is
 * spelled exactly `data` or `attributes` at the top level.
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
 * Reads one envelope property, translating a throwing accessor into the
 * documented failure type: parsed JSON never carries getters, so an accessor
 * that throws during unwrapping is programmatic caller input — the same
 * taxonomy as the non-plain-object rejection in the validation walk. Each
 * envelope property is read exactly ONCE through this helper, so a getter
 * cannot return one value for a shape check and another (or a throw) for the
 * actual read.
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
 * An envelope carrying an explicit `type` must carry THIS resource's type —
 * the generated contract's discriminator is `"project_config"`, so e.g. a
 * mixed-up response for another resource fails loudly instead of being
 * partially mapped wherever its attribute names happen to overlap. An absent
 * `type` stays tolerated (lenient toward trimmed-down callers that pass only
 * `{data:{attributes}}`).
 */
function assertProjectConfigResourceType(envelope: Record<string, unknown>): void {
  if (!Object.hasOwn(envelope, "type")) {
    return;
  }
  const resourceType = readEnvelopeProperty(envelope, "type");
  if (resourceType !== "project_config") {
    // Rendered defensively: JSON.stringify throws on a bigint discriminator,
    // which would escape the typed-error contract from inside the error
    // builder itself.
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

// Sync decode is an accepted exception (repo `CLAUDE.md`'s "Schema decoding
// and encoding" section): this is an explicitly synchronous outer boundary
// (`fromApiProjectConfig` is a plain throwing function, not an `Effect`),
// `ProjectConfigApiAttributesSchema` is service-free (no `Effect.gen`/context
// requirements — see `./api-attributes.ts`), and the thrown
// `ProjectConfigParseError` below is the documented, intentional contract for
// a decode failure here.
const decodeApiAttributes = Schema.decodeUnknownSync(ProjectConfigApiAttributesSchema);

/**
 * Builds the `message`/`apiPath`/`detail` triple for a schema decode failure
 * from the thrown `SchemaError`, via the v4 `SchemaIssue` formatters: the
 * first flattened issue's path becomes `apiPath` (stringified — a
 * `SchemaIssue` path segment is a `PropertyKey`, and an array index arrives
 * as a `number`) and its message becomes the short summary rendered into
 * `message`; the full multi-issue rendering
 * (`SchemaIssue.makeFormatterDefault()`, the same formatter `SchemaError`'s
 * own `.message` uses) becomes `detail`. Falls back to the bare
 * `SchemaError` message when `cause` isn't a `SchemaError` at all — should
 * not happen given `decodeApiAttributes` is the only caller, but this
 * function must not itself throw while building an error message.
 *
 * Normalizes an empty issue path to `undefined`: an issue at the attributes
 * ROOT (the envelope/shape itself, rather than any specific field within it)
 * reports a zero-length path, and {@link ProjectConfigParseError}'s own
 * `apiPath` docstring promises `undefined` for exactly that case — an empty
 * array reads to a consumer as "the offending path is the empty path",
 * which is a different (and wrong) claim.
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
  // A `StandardSchemaV1.Issue` path entry is a `PropertyKey` OR a
  // `{ key: PropertyKey }` `PathSegment` object per the spec; effect's own
  // formatter only ever emits the former (`SchemaIssue.ts`'s internal
  // `DefaultIssue.path: ReadonlyArray<PropertyKey>`), but the public type is
  // the wider spec shape, so this reads `.key` off an object segment rather
  // than stringifying it directly.
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
 * Walks {@link projectConfigMappingRows} against `decodedAttributes` and
 * writes every surviving mapped value into `output`. Per
 * `./registry-row.ts`'s null convention: a row whose `apiPath` is absent
 * (`undefined`) from `decodedAttributes` is always skipped, and one whose
 * value is `null` is skipped unless the row declares a `transform` (which
 * receives the `null` and decides). `isSecret` rows are never emitted — the
 * API only ever reports an HMAC digest for them (ADR 0019 rule 5).
 */
function applyMappingRows(
  decodedAttributes: ProjectConfigApiAttributes,
  output: Record<string, unknown>,
): void {
  for (const row of projectConfigMappingRows) {
    if (row.isSecret) {
      // The value is never emitted (ADR 0019 rule 5 — the API only reports
      // an HMAC digest), but a present non-string is still a malformed
      // platform response and must not vanish silently: the path is in the
      // consumed set, so without this check `unmappedApiFields` would hide
      // the malformed value too.
      const secretValue = readPath(decodedAttributes, row.apiPath);
      if (secretValue !== undefined && secretValue !== null) {
        expectString(secretValue, row.apiPath);
      }
      continue;
    }

    const rawValue = readPath(decodedAttributes, row.apiPath);
    if (rawValue === undefined) {
      // A row that also consumes sibling paths must still run when a sibling
      // is present despite the absent anchor: the sibling is in the consumed
      // set, so skipping here would silently swallow a malformed sibling
      // without it ever being validated (or reported unmapped).
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

  // The orphan secret paths (`unmappedSecretApiPaths`) get the same
  // present-non-null validation as `isSecret` rows above: they too are in the
  // consumed set, so a malformed platform value (the contract permits only
  // string or null) would otherwise vanish — never emitted AND suppressed
  // from `unmappedApiFields`.
  for (const secretPath of unmappedSecretApiPaths) {
    const secretValue = readPath(decodedAttributes, secretPath);
    if (secretValue !== undefined && secretValue !== null) {
      expectString(secretValue, secretPath);
    }
  }
}

/**
 * Guards {@link walkUnmapped} and {@link assertRawAttributesDepthWithinBound}
 * against a pathologically (or maliciously) deep response body — an object
 * graph deeper than this could otherwise overflow the call stack with an
 * uncaught `RangeError` instead of the package's own documented failure
 * type.
 */
const MAX_UNMAPPED_WALK_DEPTH = 64;

/**
 * Pre-clone depth guard for {@link attachFrozenApiResponse} (CLI-2230's
 * clone/freeze finding): `structuredClone` and {@link deepFreeze} are both
 * naive recursive walks with no depth limit of their own, so a
 * pathologically deep `rawAttributes` — say, ~50k levels of nesting under an
 * API-ahead-of-package key (unmapped fields reach `attachFrozenApiResponse`
 * verbatim; decode's own leniency never prunes them) — overflows the call
 * stack with a raw, uncaught `RangeError` from inside `structuredClone`
 * itself, before this package ever gets a chance to turn it into a {@link
 * ProjectConfigParseError}. Walking (and throwing) here, before either
 * function ever runs, catches that case first. This also bounds cycles as a
 * side effect, with no separate visited-set needed: a self-referential
 * object has no finite depth, so re-encountering the same node at every
 * increasing `depth` still exceeds {@link MAX_UNMAPPED_WALK_DEPTH}
 * deterministically, well before either function's own recursion could
 * overflow the stack.
 */
/**
 * Total node visits the raw-attributes validation walk tolerates before
 * declaring the structure pathological. A real project-config response holds
 * a few hundred nodes; this bound exists for programmatic callers handing
 * `attachApiResponse` a shared-reference DAG, where ~40 objects arranged
 * with two properties each pointing at the same next node cost ~2^40 visits
 * while staying inside the depth bound — bounding *work* (not memoizing
 * subtrees) keeps the rejection typed and also keeps the later
 * path-dependent {@link walkUnmapped} safe, since any structure that passes
 * here costs `walkUnmapped` at most the same bounded number of visits.
 * (JSON parsed off a real network response can never share references, so
 * nothing legitimate is anywhere near this bound.)
 */
const MAX_RAW_ATTRIBUTES_NODE_VISITS = 100_000;

function assertRawAttributesDepthWithinBound(
  value: unknown,
  depth = 0,
  visits: { count: number } = { count: 0 },
  // Call-site provenance for the depth/visit bounds: via fromApiProjectConfig
  // a pathological structure is a platform-response problem (upgrade
  // suggestion applies); via attachApiResponse the structure is the CALLER's
  // own data, and reporting it as an external api_status failure would
  // corrupt the KPI. Non-JSON primitives and non-plain objects stay
  // caller_misuse unconditionally — parsed JSON cannot produce them on any
  // path.
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
  // Bigint is structured-cloneable and freezable but not JSON — it would
  // land under a ReadonlyJsonValue-typed _apiResponse and blow up the first
  // JSON.stringify a consumer runs on an unmappedApiFields report. Parsed
  // JSON never produces one; programmatic caller input.
  // NaN/Infinity silently stringify to null and an undefined-valued key
  // silently vanishes under JSON.stringify — same non-JSON-primitive class.
  if (
    typeof value === "bigint" ||
    value === undefined ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new ProjectConfigParseError({
      message:
        "raw attributes hold a non-JSON primitive (a bigint, undefined, or a non-finite number) — raw attributes must be plain parsed JSON",
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
    // Only PLAIN objects pass: a Map/Set/Date/typed array is
    // structured-cloneable, but Object.freeze only freezes its wrapper — its
    // internal mutators (map.set, date.setTime) still work afterwards, so it
    // would punch a mutable hole through the deep-frozen metadata. Parsed
    // JSON never produces one. The identity check alone would also reject a
    // plain JSON payload parsed in ANOTHER REALM (an iframe handing its
    // JSON.parse result to the parent has that realm's Object.prototype), so
    // the cross-realm-safe brand check backs it up — built-ins carry their
    // own tags ("[object Map]"), a plain object reports "[object Object]"
    // from any realm.
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
 * Wraps `structuredClone` for {@link attachFrozenApiResponse}: a
 * function-valued or symbol-valued raw attribute (never a shape a real API
 * response should carry, but not excluded by this package's otherwise
 * maximally-lenient decode either — `Schema.Unknown` accepts it) fails
 * `structuredClone` with an untyped, un-tagged `DOMException` ("The object
 * can not be cloned"). Translating it here keeps that failure inside this
 * package's documented `ProjectConfigParseError` contract instead of leaking
 * a raw `DOMException` to every caller.
 */
function cloneRawAttributes(
  rawAttributes: Record<string, unknown>,
  reason: "api_response" | "caller_misuse" = "api_response",
): Record<string, unknown> {
  try {
    return structuredClone(rawAttributes);
  } catch (cause) {
    // Non-cloneable values (functions/symbols) can only be programmatic, but
    // structuredClone ALSO throws on sufficiently deep plain JSON — which a
    // platform response genuinely can be — so provenance follows the call
    // site rather than assuming misuse.
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
 * Attaches a deep-cloned, deep-frozen copy of `rawAttributes` to a fresh
 * shallow copy of `enumerableProps`'s own enumerable properties, as a
 * non-enumerable `_apiResponse` (ADR 0019 rule 1). Shared by
 * {@link fromApiProjectConfig} and the exported {@link attachApiResponse} so
 * both go through one clone+freeze path. Cloning (rather than aliasing the
 * caller's object) and freezing means neither this package nor a caller can
 * mutate the attached raw attributes after the fact — including through the
 * very reference `rawAttributes` was passed in by. Every failure mode this
 * function can hit — pathological depth/cycles ({@link
 * assertRawAttributesDepthWithinBound}) and non-cloneable values ({@link
 * cloneRawAttributes}) — is translated into {@link ProjectConfigParseError}
 * rather than left to surface as a raw `RangeError`/`DOMException`, per this
 * package's documented failure-type contract.
 */
function attachFrozenApiResponse<T extends Record<string, unknown>>(
  enumerableProps: T,
  rawAttributes: Record<string, unknown>,
  reason: "api_response" | "caller_misuse" = "api_response",
): T {
  // Clone FIRST, then validate the CLONE: validating the live input leaves a
  // time-of-check/time-of-use gap for accessor properties (a getter can
  // answer the validation walk with a plain value and hand structuredClone a
  // bigint). The clone is inert data — getters are resolved exactly once by
  // structuredClone — so what gets validated is what gets attached. A
  // pathologically deep input failing inside structuredClone itself is
  // caught and typed by cloneRawAttributes.
  const cloned = cloneRawAttributes(rawAttributes, reason);
  assertRawAttributesDepthWithinBound(cloned, 0, undefined, reason);
  return attachOwnedSnapshot(enumerableProps, cloned);
}

/**
 * Maps a Management API v2 project-config response into a {@link
 * ProjectConfig}, per ADR 0019: (1) unwraps whichever of the three envelope
 * shapes `input` is, (2) decodes the unwrapped attributes leniently — an
 * API-ahead-of-package field never fails this decode, only a genuinely
 * malformed mapped field does — (3) walks the mapping registry
 * (`./registry.ts`) to populate the typed sections, and (4) attaches a
 * deep-cloned, deep-frozen copy of the raw, unwrapped attributes as a
 * non-enumerable `_apiResponse` ({@link attachFrozenApiResponse}) so
 * `unmappedApiFields` and forward-compatible consumers can still reach
 * whatever the registry didn't map. Throws {@link ProjectConfigParseError}
 * when `input` isn't an object, when the envelope is malformed, or when
 * decoding/mapping a value fails.
 */
export function fromApiProjectConfig(input: unknown): ProjectConfig;
// Untyped for the same reason as `fromConfigDocument` above: the mapping
// walk builds its result dynamically from `./registry.ts`'s rows, which
// TypeScript cannot verify reconstructs a `ProjectConfig`; the overload above
// is the contract, pinned by the unit tests.
export function fromApiProjectConfig(input: unknown): unknown {
  const rawAttributes = unwrapApiResponse(input);
  // ONE inert snapshot for everything: clone first (getters resolve exactly
  // once — decode, mapping, and the attached metadata all read the same
  // data, so no accessor can desynchronize them), then depth/work-bound the
  // snapshot BEFORE schema decoding — the mirror's `auth` record is
  // `Schema.Json`, whose decode recurses through arbitrary nesting, so a
  // pathologically deep value would otherwise overflow with a raw RangeError
  // inside the decode, escaping the typed-error contract. structuredClone's
  // own failure modes (non-cloneables, extreme depth) are already typed by
  // cloneRawAttributes.
  const snapshot = cloneRawAttributes(rawAttributes);
  assertRawAttributesDepthWithinBound(snapshot);
  const decodedAttributes = decodeAttributes(snapshot);

  const output: Record<string, unknown> = {};
  applyMappingRows(decodedAttributes, output);
  applyDisabledSentinels(output);

  // The snapshot is already validated and exclusively owned here, so it is
  // frozen and attached directly — no second clone/validation pass.
  return attachOwnedSnapshot(output, snapshot);
}

/**
 * Freezes and attaches an ALREADY-validated, exclusively-owned snapshot —
 * the tail of {@link attachFrozenApiResponse} without the clone/validate
 * steps, for the one caller ({@link fromApiProjectConfig}) that has already
 * done both on the same object.
 */
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
  const result = { ...enumerableProps };
  Object.defineProperty(result, "_apiResponse", {
    value: frozen,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result;
}

/**
 * Re-attaches `_apiResponse` to `config` after a caller's own spread,
 * `structuredClone`, or state-store round-trip already dropped it — ADR
 * 0019 rule 1 promises the attach step exists precisely because those
 * operations are non-enumerable-property-blind by design, and a consumer
 * that legitimately needs to carry the raw attributes across such a
 * boundary (a state store, a serialized cache entry it then rehydrates) must
 * be able to restore them explicitly rather than losing `unmappedApiFields`
 * access permanently. Returns a NEW object: a shallow copy of `config`'s own
 * enumerable properties, plus `rawAttributes` attached via the same
 * clone-and-freeze path {@link fromApiProjectConfig} uses internally
 * ({@link attachFrozenApiResponse}) — never mutates `config` in place. Throws
 * {@link ProjectConfigParseError} when `config` is not an object, matching
 * {@link toProjectConfig}'s own strictness — a non-object `config` used to
 * silently substitute `{}`, discarding whatever the caller actually passed
 * instead of surfacing the misuse.
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
 * Either operand `toProjectConfig` accepts: a local {@link EffectiveConfig}
 * (a full `CliConfig` document fits, since it's assignable to it) to project
 * down to the hosted subset, or a raw, not-yet-decoded Management API v2
 * project-config response (in any of the three envelope shapes
 * {@link fromApiProjectConfig} accepts) to map.
 */
export type ToProjectConfigSource =
  | { readonly cliConfig: EffectiveConfig }
  | { readonly apiResponse: unknown };

function hasApiResponse(
  source: ToProjectConfigSource,
): source is { readonly apiResponse: unknown } {
  return Object.hasOwn(source, "apiResponse");
}

function hasCliConfig(
  source: ToProjectConfigSource,
): source is { readonly cliConfig: EffectiveConfig } {
  return Object.hasOwn(source, "cliConfig");
}

/**
 * Caller misuse — a programming error in the consumer, not a malformed
 * platform response: the message is plain (no "Management API response"
 * framing), the upgrade `suggestion` is omitted (upgrading fixes nothing),
 * and `reason: "caller_misuse"` lets apps/cli's error-actionability adapter
 * bucket it as invalid input instead of an external `api_status` failure.
 */
function callerMisuseError(detail: string): ProjectConfigParseError {
  return new ProjectConfigParseError({
    message: detail,
    cause: new Error(detail),
    reason: "caller_misuse",
  });
}

/**
 * Thin dispatcher over the two normalizers above: routes to
 * {@link fromApiProjectConfig} when `source` carries an own `apiResponse`
 * property, otherwise to {@link fromConfigDocument} when it carries an own
 * `cliConfig` property. A full `CliConfig` fits the `cliConfig` arm
 * directly, since `CliConfig` is assignable to {@link EffectiveConfig}.
 * Throws {@link ProjectConfigParseError} when `source` carries neither own
 * key or both — `{}` and `{ cliConfig: x, apiResponse: y }` are equally
 * meaningless dispatch requests, and failing loudly here beats a raw
 * `TypeError` from reaching into a property that isn't there.
 */
export function toProjectConfig(source: ToProjectConfigSource): ProjectConfig {
  // A JavaScript caller can hand this public dispatcher null/undefined
  // despite the compile-time type; guarding before the own-property
  // predicates keeps the failure inside the documented typed-error contract
  // instead of a native TypeError from Object.hasOwn.
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
    return fromApiProjectConfig(source.apiResponse);
  }
  if (hasCliConfig(source)) {
    return fromConfigDocument(source.cliConfig);
  }
  throw callerMisuseError(
    'toProjectConfig source must carry exactly one of an own "cliConfig" or "apiResponse" property, got neither',
  );
}

function pathKey(path: ReadonlyArray<string>): string {
  // JSON-encoded, not joined — a raw API key can legitimately contain any
  // candidate separator (a literal dot, even an escaped NUL), so no join
  // delimiter is collision-free. Encoding the segment array itself is
  // unambiguous for every representable key.
  return JSON.stringify(path);
}

/**
 * Every API path this registry version "knows about" — a row's own
 * `apiPath`, everything its `alsoConsumes` names, and every
 * `unmappedSecretApiPaths` entry (`./registry-auth.ts`: secret-shaped GoTrue
 * keys with no row of their own, so they'd otherwise leak an HMAC digest
 * into `unmappedApiFields`). "Consumed" here means "known to this registry
 * version", not "mapped on this run": an `alsoConsumes` sibling is suppressed
 * even on a run where its anchor row's own value was absent (e.g. Apple's
 * `external_apple_additional_client_ids` when `external_apple_client_id`
 * itself is missing) — the raw value is still there in `_apiResponse`, only
 * `unmappedApiFields` treats it as accounted for. This is intentional, not a
 * gap: the alternative (only suppress when the anchor row actually fired)
 * would report the sibling as "unmapped" even though a future run where the
 * anchor IS present would fold it in identically, which is noise, not signal.
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
 * Every PROPER prefix of a consumed path, plus the six top-level sections the
 * mirror schema declares — the containers this registry version already
 * "knows". {@link walkUnmapped} prunes a known container that is empty in the
 * raw response (an empty `postgres_settings`/`auth` carries nothing unknown
 * to report), while an empty object at an UNKNOWN path survives as drift
 * signal — a newly introduced, not-yet-populated API section.
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
  if (!isObject(value)) {
    return value;
  }
  // An empty object at an UNKNOWN path is itself information — a newly
  // introduced, not-yet-populated section would otherwise vanish here and
  // make the response look fully mapped. A KNOWN container that happens to
  // be empty (`postgres_settings: {}`, `auth: {}`) is pruned instead: there
  // is nothing unknown in it to report, and preserving it would fabricate
  // drift for perfectly ordinary responses.
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
 * The subtree of `config._apiResponse` that {@link projectConfigMappingRows}
 * does not map — `{}` when `config` carries no `_apiResponse` at all
 * (file-sourced config, or a `ProjectConfig` that was never built from an API
 * response), which per ADR 0019 rule 1 does NOT mean "fully mapped".
 * Registry-derived, not a second hand-maintained field list (ADR 0019 rule
 * 5): a path is "mapped" when some row's `apiPath` or `alsoConsumes` names it
 * exactly, including every `isSecret` row (deliberately omitted, but known)
 * and every `unmappedSecretApiPaths` entry (deliberately omitted despite
 * having no row at all). Empty objects are pruned from the result, so a
 * subtree that is entirely mapped never shows up as `{}` noise.
 *
 * The result can include the HMAC digest the API reports for a secret-typed
 * key neither a row nor `unmappedSecretApiPaths` knows about yet — a future
 * GoTrue secret, say, added on the platform side before this package's
 * `isSecret` rows catch up. Callers must not render this result blindly — an
 * HMAC digest is not a value a user should see echoed back at them. Throws
 * {@link ProjectConfigParseError} if `_apiResponse` is nested more than 64
 * levels deep.
 */
export function unmappedApiFields(config: ProjectConfig): {
  readonly [key: string]: ReadonlyJsonValue;
};
// The report's containers are rebuilt fresh, but leaf arrays/objects are
// shared BY REFERENCE with the deep-frozen `_apiResponse` — a mutable return
// type would compile `.push(...)` that throws at runtime. Same typed-overload
// pattern as the normalizers above: the implementation stays untyped because
// TypeScript cannot verify the structural walk.
export function unmappedApiFields(config: ProjectConfig): unknown {
  const rawAttributes = config._apiResponse;
  if (rawAttributes === undefined) {
    return {};
  }
  const result = walkUnmapped(rawAttributes, []);
  return isObject(result) ? result : {};
}

/**
 * The deduped `configPath`s of every non-`isSecret` row in
 * {@link projectConfigMappingRows}, in registry order — the fields
 * `fromApiProjectConfig` can actually speak for. Exists so a diff consumer
 * (CLI-2156/Studio) never hand-maintains an equivalent field list: as rows
 * are added, removed, or renamed, this set moves with them automatically.
 * Excludes secret rows (an API-sourced value for one is never populated, so
 * it can never meaningfully participate in a comparison) and every field
 * with no row at all (`realtime` in full, `workers`/`experimental`, and
 * every "Deliberately unmapped" field the sibling registries document).
 *
 * This ONLY remedies the whole-SECTION-granularity gap (e.g. `realtime` in
 * full never showing up as phantom drift just because it has zero rows). It
 * does NOT remedy the finer, per-path granularity gap this file's own
 * {@link ProjectConfig} docstring describes: `["auth", "email", "smtp",
 * "enabled"]` IS a member of this list (`isComparableProjectConfigPath`
 * returns `true` for it) and yet still fabricates drift against a document
 * operand that never declared `[auth.email.smtp]` at all, because
 * `subtractCliConfig`'s baseline has no `smtp` key to compare against and
 * therefore keeps the API side's value verbatim (pinned by
 * `project-config.unit.test.ts`'s "does NOT rescue a diff against a document
 * operand that never declared the sub-section at all" test). A caller doing
 * that comparison must additionally intersect with what the document-side
 * operand actually declared — or accept that every field a row maps
 * unconditionally will read as a remote-only statement whenever the document
 * side is silent on it, never as neutral "no opinion".
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

/** Whether `path` is a member of {@link comparableProjectConfigPaths}. */
export function isComparableProjectConfigPath(path: ReadonlyArray<string>): boolean {
  return comparableProjectConfigPathKeys.has(pathKey(path));
}
