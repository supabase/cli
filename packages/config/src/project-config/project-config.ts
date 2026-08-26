import { Schema } from "effect";
import type { CliConfig } from "../base.ts";
import { isObject } from "../config-document.ts";
import { ProjectConfigParseError } from "../errors.ts";
import { setOwnProperty, type DeepPartial, type EffectiveConfig } from "../sparse.ts";
import {
  ProjectConfigApiAttributesSchema,
  type ProjectConfigApiAttributes,
} from "./api-attributes.ts";
import { projectConfigMappingRows } from "./registry.ts";

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
 * {@link fromConfigDocument}), holding the raw, pre-mapping `data.attributes`
 * object verbatim. It is attached as a non-enumerable property at runtime
 * (rule 1), so it is invisible to `JSON.stringify`, object spread,
 * `structuredClone`, and the structural walks in `../sparse.ts` — and is
 * therefore never persisted to a config file.
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
 * whole-section presence/absence as drift against the other's.
 */
export type ProjectConfig = DeepPartial<
  Pick<CliConfig, "api" | "auth" | "db" | "realtime" | "storage" | "workers" | "experimental">
> & {
  readonly _apiResponse?: Record<string, unknown>;
};

const HOSTED_SECTION_KEYS = [
  "api",
  "auth",
  "db",
  "realtime",
  "storage",
  "workers",
  "experimental",
] as const;

/**
 * Projects a {@link CliConfig} document (or any {@link EffectiveConfig}
 * operand — a full `CliConfig` is one) down to its hosted-section subset.
 * Copies each hosted section shallowly and only when own-present on `config`
 * — the subtree reference is shared with the input, not deep-cloned, so this
 * is safe even when `config` is frozen (e.g. {@link getDefaultCliConfig}'s
 * memo) but the copy must not be mutated by a caller. Never attaches
 * `_apiResponse`; that only happens in {@link fromApiProjectConfig}.
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
      setOwnProperty(result, key, config[key]);
    }
  }
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
 * section either of those two words.
 */
function unwrapApiResponse(input: unknown): Record<string, unknown> {
  if (!isObject(input)) {
    throw new ProjectConfigParseError({
      cause: new Error(`expected an object, got ${input === null ? "null" : typeof input}`),
    });
  }
  if (Object.hasOwn(input, "data")) {
    const data = input["data"];
    if (!isObject(data) || !isObject(data["attributes"])) {
      throw new ProjectConfigParseError({
        cause: new Error('expected "data" to be an object with an "attributes" object'),
      });
    }
    return data["attributes"];
  }
  if (Object.hasOwn(input, "attributes")) {
    const attributes = input["attributes"];
    if (!isObject(attributes)) {
      throw new ProjectConfigParseError({
        cause: new Error('expected "attributes" to be an object'),
      });
    }
    return attributes;
  }
  return input;
}

// Sync decode is an accepted exception (repo `CLAUDE.md`'s "Schema decoding
// and encoding" section): this is an explicitly synchronous outer boundary
// (`fromApiProjectConfig` is a plain throwing function, not an `Effect`),
// `ProjectConfigApiAttributesSchema` is service-free (no `Effect.gen`/context
// requirements — see `./api-attributes.ts`), and the thrown
// `ProjectConfigParseError` below is the documented, intentional contract for
// a decode failure here.
const decodeApiAttributes = Schema.decodeUnknownSync(ProjectConfigApiAttributesSchema);

function decodeAttributes(rawAttributes: Record<string, unknown>): ProjectConfigApiAttributes {
  try {
    return decodeApiAttributes(rawAttributes);
  } catch (cause) {
    throw new ProjectConfigParseError({ cause });
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
 * Maps a Management API v2 project-config response into a {@link
 * ProjectConfig}, per ADR 0019: (1) unwraps whichever of the three envelope
 * shapes `input` is, (2) decodes the unwrapped attributes leniently — an
 * API-ahead-of-package field never fails this decode, only a genuinely
 * malformed mapped field does — (3) walks the mapping registry
 * (`./registry.ts`) to populate the typed sections, and (4) attaches the raw,
 * unwrapped attributes verbatim as a non-enumerable `_apiResponse` so
 * `unmappedApiFields` and forward-compatible consumers can still reach
 * whatever the registry didn't map. Throws {@link ProjectConfigParseError}
 * when `input` isn't an object, or when decoding/mapping a value fails.
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

  // Non-enumerable so `JSON.stringify`, object spread, and every
  // `Object.entries`-based structural walk (including `../sparse.ts`'s
  // `subtractValue`) skip it by construction — ADR 0019 rules 1/3/4.
  Object.defineProperty(output, "_apiResponse", {
    value: rawAttributes,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return output;
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

/**
 * Thin dispatcher over the two normalizers above: routes to
 * {@link fromApiProjectConfig} when `source` carries an own `apiResponse`
 * property, otherwise to {@link fromConfigDocument}. A full `CliConfig` fits
 * the `cliConfig` arm directly, since `CliConfig` is assignable to
 * {@link EffectiveConfig}.
 */
export function toProjectConfig(source: ToProjectConfigSource): ProjectConfig {
  if (hasApiResponse(source)) {
    return fromApiProjectConfig(source.apiResponse);
  }
  return fromConfigDocument(source.cliConfig);
}

function pathKey(path: ReadonlyArray<string>): string {
  // Joined with NUL, not "." — a raw API key can legitimately contain a
  // literal dot, which would otherwise let a one-segment key collide with an
  // unrelated two-segment registry path. NUL cannot appear in a JSON key from
  // a real API document boundary.
  return path.join("\u0000");
}

const consumedApiPathKeys: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  for (const row of projectConfigMappingRows) {
    keys.add(pathKey(row.apiPath));
    for (const alsoPath of row.alsoConsumes ?? []) {
      keys.add(pathKey(alsoPath));
    }
  }
  return keys;
})();

function walkUnmapped(value: unknown, path: ReadonlyArray<string>): unknown {
  if (consumedApiPathKeys.has(pathKey(path))) {
    return undefined;
  }
  if (!isObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const mapped = walkUnmapped(child, [...path, key]);
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
 * exactly, including every `isSecret` row (deliberately omitted, but known).
 * Empty objects are pruned from the result, so a subtree that is entirely
 * mapped never shows up as `{}` noise.
 *
 * The result can include the HMAC digest the API reports for a secret-typed
 * key this registry version doesn't know about yet — a future GoTrue secret,
 * say, added on the platform side before this package's `isSecret` rows
 * catch up. Only a *known* `isSecret` row's path is excluded from this report
 * (that's what makes it "mapped"); an unrecognized key has no row at all, so
 * this function cannot tell it apart from any other unmapped value. Callers
 * must not render this result blindly — an HMAC digest is not a value a user
 * should see echoed back at them.
 */
export function unmappedApiFields(config: ProjectConfig): Record<string, unknown> {
  const rawAttributes = config._apiResponse;
  if (rawAttributes === undefined) {
    return {};
  }
  const result = walkUnmapped(rawAttributes, []);
  return isObject(result) ? result : {};
}
