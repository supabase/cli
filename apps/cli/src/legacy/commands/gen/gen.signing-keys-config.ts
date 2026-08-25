import { loadProjectConfig, loadProjectEnvironment } from "@supabase/config/effect";
import { Effect, FileSystem, Option, Path } from "effect";
import { legacyAssertDecodableJwkAlgorithm } from "../../shared/legacy-go-jwt.ts";
import { legacyGoJsonKindName } from "../../shared/legacy-go-json.ts";
import { legacyResolveProjectEnvironmentValues } from "../../shared/legacy-project-environment.ts";

/**
 * Shared `[auth].signing_keys_path` config-loading logic for the `gen` command
 * family — used by both `gen signing-key` (`signing-key.handler.ts`, generating
 * or appending a key) and `gen bearer-jwt` (`bearer-jwt.handler.ts`, resolving
 * a key to sign with). Per `apps/cli/CLAUDE.md`'s "hoist before you duplicate"
 * rule: this logic is used by ≥2 commands in the same command family, so it
 * lives at the family root (`legacy/commands/gen/`) rather than being inlined
 * in either sibling.
 *
 * Error TYPES are intentionally NOT shared — each caller passes its own
 * tagged-error constructors (mirroring `sso.saml.ts`'s `readMetadataFile`
 * pattern), so `gen signing-key` and `gen bearer-jwt` keep independent error
 * hierarchies while sharing the actual file-resolution/read/decode logic.
 */

export type LegacyStoredSigningKeyJwk = Readonly<Record<string, unknown>>;

interface LegacyGenSigningKeysConfigPaths {
  /** CWD-relative `supabase/config.toml` (or the resolved config file's own display path). */
  readonly configDisplayPath: string;
  /**
   * `[auth].enabled` from the resolved config (default `true`). The
   * `[auth].signing_keys_path` file is only read when auth is enabled —
   * every caller that reaches this file's read through the shared config
   * load is subject to the SAME gate. With `auth.enabled = false` and a
   * configured `signing_keys_path` file, `gen signing-key --append` never
   * reads that file's real content at all — it appends to (and a
   * subsequent write clobbers) the default single-key array instead,
   * discarding whatever was actually on disk. Both `gen bearer-jwt`'s
   * `getSigningKey` ({@link legacyResolveBearerJwtSigningKey}) and `gen
   * signing-key` ({@link legacyGenSigningKey}) branch on this field for
   * exactly that reason.
   */
  readonly authEnabled: boolean;
  /** `Option.some` when `[auth].signing_keys_path` is configured (non-empty). */
  readonly signingKeysPath: Option.Option<{
    readonly actualPath: string;
    readonly displayPath: string;
  }>;
}

/**
 * `typeof value === "object"` is also `true` for a JSON array — without excluding
 * `Array.isArray(value)`, a `signing_keys_path` entry shaped like `[]` (or any nested
 * array) would pass this check and be accepted as a JWK-shaped record. An
 * array-shaped element must be rejected with `"json: cannot unmarshal array
 * into Go value of type config.JWK"`: `[[], {"kty":"EC","kid":"k2"}]` fails
 * decoding outright, it does not partially accept `k2` the way this check
 * would without the array exclusion.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `legacyGoJsonKindName` (`legacy-go-json.ts`) is deliberately scoped to
 * scalars only — every one of its existing call sites already excludes null/array/
 * object before reaching it. This file's per-field JWK checks below DO need to name a
 * bare JSON object (`key_ops`'s elements, or a nested value under any field, can be an
 * object — a `--payload`-style `{}` inside `key_ops` must report
 * `"...into Go struct field JWK.key_ops of type string"` with kind `object`),
 * so this is a local superset rather than a change to that shared, narrower contract.
 */
function jwkFieldKindName(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return "object";
  }
  return legacyGoJsonKindName(value);
}

/**
 * Established `encoding/json` struct-field type-mismatch text: `"json: cannot
 * unmarshal <kind> into Go struct field JWK.<field> of type <goType>"` — for
 * every field this file reads: `kty`/`kid`/`use`/`alg`/`n`/`e`/`d`/`p`/`q`/
 * `dp`/`dq`/`qi`/`crv`/`x`/`y` (`goType: "string"`), `key_ops` as a whole
 * (`goType: "[]string"`) vs. one of its elements (`goType: "string"`, the same
 * as any other string field), and `ext` (`goType: "bool"`).
 */
function jwkStructFieldTypeMismatch(field: string, value: unknown, goType: string): string {
  return `json: cannot unmarshal ${jwkFieldKindName(value)} into Go struct field JWK.${field} of type ${goType}`;
}

/**
 * A JSON `null` for any `config.JWK` field is a documented `encoding/json`
 * no-op — same as a `null` for the whole JWK (see `bearer-jwt.signing-key.ts`'s
 * `resolveSigningKeyFromStdinJwk` doc comment) — so `null` must NOT be treated as a type
 * mismatch here, only as "absent".
 */
function isAbsentJwkField(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * `encoding/json`-style struct-field matching is case-insensitive — the
 * decoder "match[es] incoming object keys to the keys used by Marshal
 * (either the struct field name or its tag), preferring an exact match but
 * also accepting a case-insensitive match" — and `config.JWK` gets NO
 * field-specific exemption from this: every field this file reads (`kty`,
 * `kid`, `use`, `key_ops`, `alg`, `ext`, `n`, `e`, `d`, `p`, `q`, `dp`, `dq`,
 * `qi`, `crv`, `x`, `y`), including `alg` despite its extra
 * `encoding.TextUnmarshaler` hook — `{"KTY":"EC","ALG":"ES256"}` decodes
 * identically to the all-lowercase spelling. A plain `record[field]` index
 * (JS property access is always exact-case) would otherwise treat
 * `"KTY"`/`"ALG"`/etc. as absent instead of decoding them, incorrectly
 * rejecting keys the established decoder accepts.
 *
 * When MULTIPLE case-variant spellings of the same field are present, the
 * decoder processes JSON keys strictly in SOURCE order and overwrites the
 * struct field on each match, so whichever case-variant key comes LAST in
 * the object wins: `{"KTY":"EC","kty":"RSA"}` decodes to `kty:"RSA"`, and
 * `{"kty":"EC","KTY":"RSA"}` also decodes to `kty:"RSA"` (the later key,
 * regardless of casing, always wins). This only GENERALIZES `JSON.parse`'s
 * own already-relied-on last-value-wins behavior for a same-case duplicate
 * key to cross-case duplicates too — it never changes the answer for an
 * object with no case-variant duplicates.
 */
export function resolveJwkFieldValue(record: Record<string, unknown>, field: string): unknown {
  let value: unknown;
  let found = false;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === field) {
      value = record[key];
      found = true;
    }
  }
  return found ? value : undefined;
}

/**
 * Reads an optional STRING field, throwing the established struct-field
 * type-mismatch text (see {@link jwkStructFieldTypeMismatch}) when the field
 * is PRESENT with a non-string value — e.g. `{"kid":123}` or `{"ext":"true"}`
 * — rather than silently treating a malformed field as absent. Decoding into
 * `config.JWK` fails outright on any such field, so a mistyped optional
 * field must never let a caller mint a token as if the field had simply
 * been omitted. Hoisted here (rather than living only in
 * `bearer-jwt.signing-key.ts`) because {@link assertNoMalformedDuplicateJwkField} — used
 * by BOTH `gen signing-key` and `gen bearer-jwt` via {@link legacyReadSigningKeysFile} —
 * needs the exact same per-field check. Looks the field up case-insensitively
 * via {@link resolveJwkFieldValue} to match the established case-insensitive
 * struct-field matching.
 */
export function readOptionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = resolveJwkFieldValue(record, field);
  if (isAbsentJwkField(value)) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(jwkStructFieldTypeMismatch(field, value, "string"));
  }
  return value;
}

/**
 * Reads the optional `key_ops` STRING ARRAY field, throwing the established
 * struct-field type-mismatch text (see {@link jwkStructFieldTypeMismatch})
 * when the field is PRESENT but is not an array (`goType: "[]string"`) or
 * contains a non-string, non-null element (`goType: "string"`, each element
 * is decoded individually into the slice's element type) — same "never
 * silently treat malformed as absent" rule as {@link readOptionalString}.
 * See that function's doc comment for why this is exported from the family
 * root rather than kept local to `bearer-jwt.signing-key.ts`.
 *
 * A `null` ELEMENT (e.g. `"key_ops":["sign",null]`) is its own separate
 * zero-value case, one level deeper than {@link isAbsentJwkField}'s "the
 * whole field is absent": a `null` slice element decodes into `[]string` as
 * that element's zero value (`""`), not a type mismatch —
 * `json.Unmarshal(["sign", null], &[]string{})` yields `["sign", ""]` with
 * no error — and `key_ops` is never even READ by signing (it only inspects
 * `kty`/`Algorithm`/the key-material fields), so a JWK with a `null`
 * `key_ops` element still signs successfully, where this function
 * previously rejected it outright.
 */
export function readOptionalStringArray(
  record: Record<string, unknown>,
  field: string,
): ReadonlyArray<string> | undefined {
  const value = resolveJwkFieldValue(record, field);
  if (isAbsentJwkField(value)) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(jwkStructFieldTypeMismatch(field, value, "[]string"));
  }
  return value.map((entry) => {
    if (entry === null) {
      return "";
    }
    if (typeof entry !== "string") {
      throw new Error(jwkStructFieldTypeMismatch(field, entry, "string"));
    }
    return entry;
  });
}

/**
 * Reads the optional `ext` BOOLEAN field (`*bool`), throwing the established
 * struct-field type-mismatch text (see {@link jwkStructFieldTypeMismatch}) when the
 * field is PRESENT with a non-boolean value — e.g. `{"ext":"true"}` or `{"ext":1}` —
 * same "never silently treat malformed as absent" rule as {@link readOptionalString}.
 * See that function's doc comment for why this is exported from the family root.
 */
export function readOptionalBoolean(
  record: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = resolveJwkFieldValue(record, field);
  if (isAbsentJwkField(value)) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(jwkStructFieldTypeMismatch(field, value, "bool"));
  }
  return value;
}

/**
 * Every plain-`string` `config.JWK` field EXCEPT `alg` — `alg`'s own `config.Algorithm`
 * type additionally implements `encoding.TextUnmarshaler` (the RS256/ES256 allowlist,
 * `pkg/config/auth.go:80-86`), which changes ITS duplicate-key mechanics enough that
 * {@link assertNoMalformedDuplicateJwkField} checks it separately — see that function's
 * doc comment.
 */
const JWK_PLAIN_STRING_FIELDS = [
  "kty",
  "kid",
  "use",
  "n",
  "e",
  "d",
  "p",
  "q",
  "dp",
  "dq",
  "qi",
  "crv",
  "x",
  "y",
] as const;

/**
 * Advances past exactly one JSON value starting at `text[start]` (after any leading
 * whitespace), returning the index of the first character after that value — a minimal
 * span-only JSON tokenizer (it never builds a JS value) shared by
 * {@link splitJsonArrayElementTexts} and `findTopLevelObjectFieldOccurrences`. Tracks
 * string-literal state (including `\"` escapes) so structural characters (`{}[]:,`)
 * inside a string never affect nesting depth — a naive brace/bracket counter would
 * otherwise mis-parse a value like `"a,b}c"`. Only ever called on text that has ALREADY
 * parsed successfully as a whole via `JSON.parse` (a duplicate key is a semantic oddity
 * `JSON.parse` tolerates, not a syntax error), so this can assume well-formed JSON
 * grammar throughout — the `i === start` guards below are defense-in-depth against a
 * hang, not a correctness requirement for well-formed input.
 */
function skipJsonValue(text: string, start: number): number {
  let i = start;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  const skipString = () => {
    i++; // opening quote
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      i++;
      if (c === '"') break;
    }
  };
  const ch = text[i];
  if (ch === '"') {
    skipString();
    return i;
  }
  if (ch === "{" || ch === "[") {
    const close = ch === "{" ? "}" : "]";
    let depth = 1;
    i++;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === '"') {
        skipString();
        continue;
      }
      if (c === ch) depth++;
      else if (c === close) depth--;
      i++;
    }
    return i;
  }
  // number / true / false / null.
  while (i < text.length && !",}] \n\r\t".includes(text[i] ?? "")) i++;
  return i === start ? start + 1 : i; // never stall on an unexpected character.
}

/**
 * Splits a JSON *array* literal's own top-level elements into their exact source
 * substrings — respecting nested strings/objects/arrays so a comma or bracket inside a
 * nested value never splits an element early — WITHOUT ever re-serializing them through
 * `JSON.stringify` (which could reorder/reformat, and can't reproduce a source-only
 * artifact like a duplicate key at all). {@link legacyReadSigningKeysFile} uses this to
 * recover each `signing_keys_path` entry's OWN untouched text for
 * {@link assertNoMalformedDuplicateJwkField} — `JSON.parse`, which the array as a WHOLE
 * already went through for the ordinary shape checks in that function, has by that
 * point already discarded the very duplicate-key evidence that check exists to find.
 */
function splitJsonArrayElementTexts(arrayText: string): ReadonlyArray<string> {
  const result: Array<string> = [];
  let i = 0;
  while (i < arrayText.length && /\s/.test(arrayText[i] ?? "")) i++;
  if (arrayText[i] !== "[") return result;
  i++;
  while (i < arrayText.length && /\s/.test(arrayText[i] ?? "")) i++;
  if (arrayText[i] === "]") return result;
  while (i < arrayText.length) {
    while (i < arrayText.length && /\s/.test(arrayText[i] ?? "")) i++;
    const start = i;
    i = skipJsonValue(arrayText, i);
    result.push(arrayText.slice(start, i));
    while (i < arrayText.length && /\s/.test(arrayText[i] ?? "")) i++;
    if (arrayText[i] === ",") {
      i++;
      continue;
    }
    break;
  }
  return result;
}

/**
 * Returns every top-level field of a JSON *object* literal, keyed by the field name
 * LOWERCASED, with ALL occurrences' raw source substrings preserved in true source
 * order — including duplicates `JSON.parse` would silently collapse down to just the
 * last one, AND case-variant "duplicates" of the same `config.JWK` field (e.g. `{"KID":
 * 1,"kid":"k"}`) that a same-case-only grouping would otherwise miss entirely:
 * `encoding/json`-style matching resolves struct fields case-insensitively (see
 * {@link resolveJwkFieldValue}'s doc comment), so `KID` and `kid` here both feed the
 * SAME struct field and must be checked together, in true relative source order, for
 * {@link assertNoMalformedDuplicateJwkField} to catch a malformed earlier occurrence
 * regardless of which case variant it used (`{"KID":123,"kid":"validkid"}` still
 * errors `"...JWK.kid..."`, even though `kid`'s own final, valid occurrence comes
 * later). Grouping by lowercase here — rather than post-hoc merging per-key arrays
 * after the fact — keeps every occurrence in exactly the order it appeared in the
 * source, regardless of which case variant it used.
 */
function findTopLevelObjectFieldOccurrences(
  objectText: string,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const result = new Map<string, Array<string>>();
  let i = 0;
  while (i < objectText.length && /\s/.test(objectText[i] ?? "")) i++;
  if (objectText[i] !== "{") return result;
  i++;
  while (i < objectText.length && /\s/.test(objectText[i] ?? "")) i++;
  if (objectText[i] === "}") return result;
  while (i < objectText.length) {
    while (i < objectText.length && /\s/.test(objectText[i] ?? "")) i++;
    const keyStart = i;
    i = skipJsonValue(objectText, i);
    const key = (JSON.parse(objectText.slice(keyStart, i)) as string).toLowerCase();
    while (i < objectText.length && /\s/.test(objectText[i] ?? "")) i++;
    if (objectText[i] === ":") i++;
    while (i < objectText.length && /\s/.test(objectText[i] ?? "")) i++;
    const valueStart = i;
    i = skipJsonValue(objectText, i);
    const valueText = objectText.slice(valueStart, i);
    const existing = result.get(key);
    if (existing === undefined) result.set(key, [valueText]);
    else existing.push(valueText);
    while (i < objectText.length && /\s/.test(objectText[i] ?? "")) i++;
    if (objectText[i] === ",") {
      i++;
      continue;
    }
    break;
  }
  return result;
}

/**
 * Detects a JWK-shaped object literal's raw source text having a KNOWN `config.JWK`
 * field repeated with an EARLIER occurrence that must be rejected, even when the
 * LAST occurrence — the only one `JSON.parse` actually keeps, per plain JS
 * object-literal semantics — is perfectly valid on its own. `JSON.parse` collapsing
 * `{"kid":1,"kid":"k"}` down to `{kid: "k"}` erases the very evidence
 * `readOptionalString`/etc. would need to catch the earlier `1`.
 *
 * Two genuinely different mechanics depending on the field:
 *
 * - **Plain `string`/`[]string`/`*bool` fields** (every field here except `alg`):
 *   `encoding/json`-style decoding processes duplicate occurrences in source order and
 *   ALWAYS continues past a type-mismatched occurrence to try the next one (a later
 *   valid occurrence DOES get written into the struct) — but the decode's own
 *   returned error is always the FIRST mismatch found, regardless of what a later
 *   occurrence does. Net effect: if ANY occurrence of a plain field mismatches,
 *   decoding errors, full stop — which is exactly what iterating every occurrence
 *   through the same {@link readOptionalString}/{@link readOptionalStringArray}/
 *   {@link readOptionalBoolean} the merged value already goes through, in source
 *   order, reproduces (first thrown wins, same as the established first-saved
 *   error).
 * - **`alg`**: `config.Algorithm` additionally implements `encoding.TextUnmarshaler`
 *   (the RS256/ES256 allowlist). Once an EARLIER occurrence's `UnmarshalText` itself
 *   returns a non-nil error (i.e. a validly-typed but disallowed string, like `"HS256"`),
 *   the decoder never even ATTEMPTS a later occurrence of `alg`:
 *   `json.Unmarshal` of `{"alg":"HS256","alg":"ES256"}` into a `config.JWK`-shaped struct
 *   still errors `"must be one of [RS256 ES256]"`, and the field never advances past the
 *   first, disallowed value, even though `"ES256"` alone would have been fine and is the
 *   value `JSON.parse` alone would have kept. A bare JSON-type mismatch on `alg` (e.g. a
 *   number) behaves like the plain-field case above instead — the outer struct-field
 *   type check runs BEFORE `UnmarshalText` is ever reached, and does not block later
 *   occurrences the way `UnmarshalText`'s OWN error does. So `alg` needs both checks, in
 *   order, per occurrence: {@link readOptionalString} (type) then
 *   {@link legacyAssertDecodableJwkAlgorithm} (allowlist) — first thrown wins, matching
 *   the established first-saved-error behavior exactly for this field too.
 *
 * Checks known fields in a fixed order (not the object's own source order) — an accepted
 * gap already documented on `bearer-jwt.signing-key.ts`'s `normalizeStoredJwk` for the
 * analogous "multiple simultaneously-malformed DISTINCT fields" case, which this
 * inherits: every genuinely malformed duplicate is still rejected, just not always
 * attributed to the established first field when more than one is wrong at once.
 *
 * A no-op (never throws, never even builds `findTopLevelObjectFieldOccurrences`'s full
 * map unnecessarily) for an object with no duplicated known field — the overwhelmingly
 * common case, where every value `readOptionalString`/etc. would need to inspect is
 * exactly the one they already inspect via the merged value downstream.
 */
export function assertNoMalformedDuplicateJwkField(objectText: string): void {
  const occurrences = findTopLevelObjectFieldOccurrences(objectText);

  const alg = occurrences.get("alg");
  if (alg !== undefined && alg.length >= 2) {
    for (const rawValue of alg) {
      const checked = readOptionalString({ alg: JSON.parse(rawValue) }, "alg");
      legacyAssertDecodableJwkAlgorithm(checked);
    }
  }

  for (const field of JWK_PLAIN_STRING_FIELDS) {
    const values = occurrences.get(field);
    if (values === undefined || values.length < 2) continue;
    for (const rawValue of values) {
      readOptionalString({ [field]: JSON.parse(rawValue) }, field);
    }
  }

  const keyOps = occurrences.get("key_ops");
  if (keyOps !== undefined && keyOps.length >= 2) {
    for (const rawValue of keyOps) {
      readOptionalStringArray({ key_ops: JSON.parse(rawValue) }, "key_ops");
    }
  }

  const ext = occurrences.get("ext");
  if (ext !== undefined && ext.length >= 2) {
    for (const rawValue of ext) {
      readOptionalBoolean({ ext: JSON.parse(rawValue) }, "ext");
    }
  }
}

/**
 * Resolves `supabase/config.toml`'s display path and `[auth].signing_keys_path`'s
 * actual/display path — no file I/O on the keys path itself (see
 * {@link legacyReadSigningKeysFile} for that).
 */
export const legacyResolveSigningKeysConfigPaths = Effect.fnUntraced(function* <E>(
  cwd: string,
  onConfigParseError: (message: string) => E,
) {
  const path = yield* Path.Path;
  // The dotenv cascade must run BEFORE `loadFromFile` ever decodes `env(...)`
  // TOML references — and that cascade reaches `.env.<SUPABASE_ENV>[.local]`
  // files AND the project-root directory (`<workdir>/.env`), not just
  // `supabase/.env`/`.env.local`. `loadProjectConfig`'s OWN internal env
  // resolution (used whenever `options.projectEnv` is omitted,
  // `@supabase/config`'s `loadProjectEnvironment`) only covers that narrower
  // `supabase/`-dir, env-agnostic half — so `[auth].signing_keys_path =
  // "env(KEYS_PATH)"` with `KEYS_PATH` set only in
  // `.env.development`/`<workdir>/.env` would otherwise stay literally
  // unexpanded here even though the established behavior resolves and signs
  // with it fine. Fills the exact same gap `legacy-local-project-context.ts`'s
  // `legacyLoadLocalProjectContext` already fills for `stop`/`status`, via the
  // same two-step resolution.
  const projectEnv = yield* loadProjectEnvironment({
    cwd,
    baseEnv: process.env,
    search: false,
    skipEnvLocal: (process.env["SUPABASE_ENV"] || "development") === "test",
  }).pipe(
    Effect.mapError((cause) => onConfigParseError(`failed to read config: ${String(cause)}`)),
  );
  const projectEnvValues = yield* Effect.try({
    try: () => legacyResolveProjectEnvironmentValues(projectEnv, cwd),
    catch: (cause) => onConfigParseError(`failed to read config: ${String(cause)}`),
  });
  const loaded = yield* loadProjectConfig(cwd, {
    projectEnv: projectEnv !== null ? { ...projectEnv, values: projectEnvValues } : undefined,
    goViperCompat: true,
    // `cwd` here is the ALREADY-resolved `LegacyCliConfig.workdir` (the
    // ancestor climb already ran once to produce it — see
    // `legacy-cli-config.layer.ts`'s `resolveWorkdir`). Without `search: false`, this
    // call would climb AGAIN from `cwd`, which diverges from the established
    // behavior whenever an explicit `--workdir` points at a subdirectory
    // below another project's root: the established behavior changes
    // directly into that exact subdirectory (no climb once
    // `--workdir`/`SUPABASE_WORKDIR` is set) and finds no
    // `supabase/config.toml` there, while this call would otherwise still
    // find the ANCESTOR project's config — regressing to the ancestor's
    // `signing_keys_path` leaking into the picker prompt.
    // `tomlOnly: true`: there is no concept of a JSON project config file, so
    // a stray `supabase/config.json` must never win over `config.toml` here
    // either (`legacy-local-project-context.ts` establishes this exact pair
    // of options for the same underlying reason).
    search: false,
    tomlOnly: true,
  }).pipe(
    Effect.catchTag("ProjectConfigParseError", (cause) =>
      Effect.fail(onConfigParseError(`failed to parse ${cause.path}: ${String(cause.cause)}`)),
    ),
  );
  if (loaded === null) {
    return {
      configDisplayPath: path.join("supabase", "config.toml"),
      authEnabled: true,
      signingKeysPath: Option.none(),
    } satisfies LegacyGenSigningKeysConfigPaths;
  }

  // The CWD-relative `supabase/config.toml` is displayed, never an absolute
  // path. `@supabase/config` always resolves `loaded.path` to an absolute
  // path, so relativize it back against the project root.
  const projectRoot = path.dirname(path.dirname(loaded.path));
  const configDisplayPath = path.relative(projectRoot, loaded.path);
  const authEnabled = loaded.config.auth.enabled;

  const configuredPath = loaded.config.auth.signing_keys_path;
  if (configuredPath === undefined || configuredPath.length === 0) {
    return {
      configDisplayPath,
      authEnabled,
      signingKeysPath: Option.none(),
    } satisfies LegacyGenSigningKeysConfigPaths;
  }

  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(path.dirname(loaded.path), configuredPath);
  const displayPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.relative(projectRoot, resolvedPath);
  return {
    configDisplayPath,
    authEnabled,
    signingKeysPath: Option.some({ actualPath: resolvedPath, displayPath }),
  } satisfies LegacyGenSigningKeysConfigPaths;
});

/**
 * Reads and JSON-decodes a `[auth].signing_keys_path` file at `actualPath` into an array of
 * JWK-shaped records. Established error wrapping (`"failed to read signing keys: %w"` /
 * `"failed to decode signing keys: %w"`) — the "expected a JSON array [of
 * objects]" shape check matches this package's own pre-existing `gen
 * signing-key` behavior (not a literal error string; decode failures come
 * from `encoding/json`-style type-mismatch errors, which `readJwkArray`'s two
 * checks approximate).
 *
 * The `alg` allowlist check and the duplicate-field check below ARE literal
 * established error strings (or reproductions of the established
 * struct-field type-mismatch text), unlike the shape checks above: decoding
 * straight into `[]config.JWK` runs the full `encoding/json` struct decode —
 * including `config.Algorithm.UnmarshalText` (the RS256/ES256 allowlist) —
 * for every element, wrapped here as `"failed to decode signing keys: failed
 * to parse response body: %w"`. {@link assertNoMalformedDuplicateJwkField}
 * closes the gap where an element has a duplicate top-level field whose
 * earlier occurrence `JSON.parse` alone would have discarded before either
 * check ever saw it.
 */
export const legacyReadSigningKeysFile = Effect.fnUntraced(function* <E1, E2>(
  actualPath: string,
  onReadError: (message: string) => E1,
  onDecodeError: (message: string) => E2,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs
    .readFileString(actualPath)
    .pipe(Effect.mapError((cause) => onReadError(`failed to read signing keys: ${String(cause)}`)));
  const decoded = yield* Effect.try({
    // Decoding is a single `json.Decoder.Decode`-style call, which reads
    // exactly ONE JSON value and never checks for trailing bytes — content
    // after that first value (even further syntactically-valid JSON, e.g. a
    // `signing_keys_path` file containing `"[validKey] []"`) is silently
    // ignored, not an error. Plain `JSON.parse` requires the ENTIRE string to
    // be exactly one value and throws on anything left over, so parse only
    // the first value's own source span — reusing the same
    // {@link skipJsonValue} span-scanner {@link splitJsonArrayElementTexts}
    // already uses below — to match the established decode-once-ignore-the-rest
    // behavior: signing still succeeds with `validKey` from a
    // `signing_keys_path` file containing `[validKey] []`.
    try: () => JSON.parse(raw.slice(0, skipJsonValue(raw, 0))),
    catch: (cause) => onDecodeError(`failed to decode signing keys: ${String(cause)}`),
  });
  if (!Array.isArray(decoded)) {
    return yield* Effect.fail(
      onDecodeError("failed to decode signing keys: expected a JSON array"),
    );
  }
  // A bare `null` ARRAY ELEMENT (as opposed to `isAbsentJwkField`'s "a FIELD is
  // absent") is an `encoding/json`-style zero-value case, not a type mismatch: a
  // `null` decoded into `config.JWK` (a struct, not a pointer) leaves every field at
  // its zero value, same as `bearer-jwt.signing-key.ts`'s `resolveSigningKeyFromStdinJwk`
  // already documents for a pasted `null` JWK. So `null` must normalize to `{}`
  // (an empty record — {@link readOptionalString}/etc. treat every field as absent)
  // rather than fail this shape check outright, regardless of WHERE in the array it
  // appears. With `signing_keys_path` decoding to `[validKey, null]`, config
  // validation succeeds (`generateAPIKeys` signs with `SigningKeys[0]`, which
  // is `validKey`), and a non-TTY `gen bearer-jwt` can still select
  // `validKey` by kid or blank-input fallback — a `[null, validKey]`
  // ordering is different (already adjudicated on this PR):
  // `SigningKeys[0]` there is the null-decoded zero-value JWK, so
  // `generateAPIKeys` itself fails signing before selection is ever reached
  // — but that later, ALREADY-REJECTED failure is the established downstream
  // signing behavior, not a reason for this decode step to reject either
  // ordering up front.
  for (const item of decoded) {
    if (item !== null && !isRecord(item)) {
      return yield* Effect.fail(
        onDecodeError("failed to decode signing keys: expected a JSON array of objects"),
      );
    }
  }
  const elementTexts = splitJsonArrayElementTexts(raw);
  const normalized: Array<Record<string, unknown>> = [];
  for (const [index, item] of (
    decoded as ReadonlyArray<Record<string, unknown> | null>
  ).entries()) {
    const record = item === null ? {} : item;
    const elementText = elementTexts[index];
    try {
      // Case-insensitive lookup (`resolveJwkFieldValue`) — the `alg`
      // allowlist check (`config.Algorithm.UnmarshalText`) runs at
      // JSON-decode time regardless of the key's casing; see that
      // function's doc comment.
      const alg = resolveJwkFieldValue(record, "alg");
      legacyAssertDecodableJwkAlgorithm(typeof alg === "string" ? alg : undefined);
      if (elementText !== undefined) {
        assertNoMalformedDuplicateJwkField(elementText);
      }
    } catch (cause) {
      return yield* Effect.fail(
        onDecodeError(
          `failed to decode signing keys: failed to parse response body: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
    normalized.push(record);
  }
  return normalized as ReadonlyArray<LegacyStoredSigningKeyJwk>;
});
