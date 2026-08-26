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
  readonly _apiResponse?: Record<string, unknown>;
};

/**
 * Deep-copies `value` (a hosted-section subtree rooted at `path`), dropping
 * every leaf whose full path matches an `x-secret` schema annotation
 * (CLI-2230's secret-omission finding): `fromConfigDocument`'s input is a
 * *decoded* `CliConfig`/`EffectiveConfig`, where `secret()`-annotated fields
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
 * (via `.slice()`) but never descended into for secret paths — no
 * `x-secret` leaf in `CliConfigSchema` sits inside an array, and this
 * mirrors `../sparse.ts`'s own array-is-atomic rule.
 */
function copyHostedValueWithoutSecrets(value: unknown, path: ReadonlyArray<string>): unknown {
  if (Array.isArray(value)) {
    return value.slice();
  }
  if (isObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      if (isSecretPath(childPath)) {
        continue;
      }
      setOwnProperty(result, key, copyHostedValueWithoutSecrets(child, childPath));
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
  const result: Record<string, unknown> = {};
  for (const key of HOSTED_SECTION_KEYS) {
    if (Object.hasOwn(config, key)) {
      setOwnProperty(result, key, copyHostedValueWithoutSecrets(config[key], [key]));
    }
  }
  applyDocumentNormalizations(result);
  return result;
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
    const data = input["data"];
    if (!isObject(data)) {
      throw envelopeError("data is not an object");
    }
    if (!isObject(data["attributes"])) {
      throw envelopeError("data.attributes is not an object");
    }
    return data["attributes"];
  }
  if (Object.hasOwn(input, "attributes")) {
    const attributes = input["attributes"];
    if (!isObject(attributes)) {
      throw envelopeError("attributes is not an object");
    }
    return attributes;
  }
  return input;
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
  const apiPath = firstIssue?.path?.map((segment) =>
    String(typeof segment === "object" ? segment.key : segment),
  );
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
      continue;
    }

    const rawValue = readPath(decodedAttributes, row.apiPath);
    if (rawValue === undefined) {
      continue;
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
}

/**
 * Attaches a deep-cloned, deep-frozen copy of `rawAttributes` to a fresh
 * shallow copy of `enumerableProps`'s own enumerable properties, as a
 * non-enumerable `_apiResponse` (ADR 0019 rule 1). Shared by
 * {@link fromApiProjectConfig} and the exported {@link attachApiResponse} so
 * both go through one clone+freeze path. Cloning (rather than aliasing the
 * caller's object) and freezing means neither this package nor a caller can
 * mutate the attached raw attributes after the fact — including through the
 * very reference `rawAttributes` was passed in by.
 */
function attachFrozenApiResponse<T extends Record<string, unknown>>(
  enumerableProps: T,
  rawAttributes: Record<string, unknown>,
): T {
  const result = { ...enumerableProps };
  Object.defineProperty(result, "_apiResponse", {
    value: deepFreeze(structuredClone(rawAttributes)),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result;
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
  const decodedAttributes = decodeAttributes(rawAttributes);

  const output: Record<string, unknown> = {};
  applyMappingRows(decodedAttributes, output);

  return attachFrozenApiResponse(output, rawAttributes);
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
 * ({@link attachFrozenApiResponse}) — never mutates `config` in place.
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
  return attachFrozenApiResponse(isObject(config) ? config : {}, rawAttributes);
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

function ambiguousSourceError(detail: string): ProjectConfigParseError {
  return new ProjectConfigParseError({
    message: formatProjectConfigParseErrorMessage(detail),
    cause: new Error(detail),
    suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
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
  if (hasApiResponse(source)) {
    if (hasCliConfig(source)) {
      throw ambiguousSourceError(
        'expected exactly one of an own "cliConfig" or "apiResponse" property, got both',
      );
    }
    return fromApiProjectConfig(source.apiResponse);
  }
  if (hasCliConfig(source)) {
    return fromConfigDocument(source.cliConfig);
  }
  throw ambiguousSourceError(
    'expected exactly one of an own "cliConfig" or "apiResponse" property, got neither',
  );
}

function pathKey(path: ReadonlyArray<string>): string {
  // Joined with NUL, not "." — a raw API key can legitimately contain a
  // literal dot, which would otherwise let a one-segment key collide with an
  // unrelated two-segment registry path. NUL cannot appear in a JSON key from
  // a real API document boundary.
  return path.join("\u0000");
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
 * Guards {@link walkUnmapped} against a pathologically (or maliciously) deep
 * response body — an object graph deeper than this could otherwise overflow
 * the call stack with an uncaught `RangeError` instead of the package's own
 * documented failure type.
 */
const MAX_UNMAPPED_WALK_DEPTH = 64;

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
export function unmappedApiFields(config: ProjectConfig): Record<string, unknown> {
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
