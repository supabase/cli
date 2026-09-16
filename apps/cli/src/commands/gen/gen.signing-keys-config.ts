import { loadCliProjectEnvironment } from "@supabase/config/effect";
import { loadCliConfig } from "@supabase/config/internal";
import { Effect, FileSystem, Option, Path } from "effect";
import { assertDecodableJwkAlgorithm } from "../../command-internal/go-jwt.ts";
import { goJsonKindName } from "../../command-internal/go-json.ts";
import { resolveProjectEnvironmentValues } from "../../command-internal/project-environment.ts";

/**
 * Shared `[auth].signing_keys_path` config-loading logic for `gen signing-key` and `gen
 * bearer-jwt`. Each caller passes its own tagged-error constructors, so the two commands keep
 * independent error hierarchies while sharing file resolution, reading, and decoding.
 */

export type StoredSigningKeyJwk = Readonly<Record<string, unknown>>;

interface GenSigningKeysConfigPaths {
  /** CWD-relative `supabase/config.toml` (or the resolved config file's own display path). */
  readonly configDisplayPath: string;
  /**
   * `[auth].enabled` from the resolved config (default `true`). The `signing_keys_path` file is
   * only read when this is `true` — see {@link resolveBearerJwtSigningKey} and {@link genSigningKey}.
   */
  readonly authEnabled: boolean;
  /** `Option.some` when `[auth].signing_keys_path` is configured (non-empty). */
  readonly signingKeysPath: Option.Option<{
    readonly actualPath: string;
    readonly displayPath: string;
  }>;
}

/**
 * Excludes arrays: `typeof value === "object"` is also `true` for `[]`, but an array-shaped
 * `signing_keys_path` entry must be rejected, not accepted as a JWK-shaped record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extends `goJsonKindName` to also name a bare object, needed when a JWK field holds `{}`. */
function jwkFieldKindName(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return "object";
  }
  return goJsonKindName(value);
}

/** Reproduces `encoding/json`'s struct-field type-mismatch text: `"json: cannot unmarshal <kind> into Go struct field JWK.<field> of type <goType>"`. */
function jwkStructFieldTypeMismatch(field: string, value: unknown, goType: string): string {
  return `json: cannot unmarshal ${jwkFieldKindName(value)} into Go struct field JWK.${field} of type ${goType}`;
}

/** `null` is treated as absent, not a type mismatch, matching `encoding/json`'s zero-value semantics for a null field. */
function isAbsentJwkField(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * Looks up a JWK field case-insensitively, matching `encoding/json`'s struct-field matching.
 * When multiple case-variant keys are present, the last one in source order wins.
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
 * Reads an optional string field, throwing {@link jwkStructFieldTypeMismatch} when the field
 * is present with a non-string value rather than treating it as absent.
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
 * Reads the optional `key_ops` field, throwing {@link jwkStructFieldTypeMismatch} when present
 * but not an array or containing a non-string, non-null element. A `null` element decodes to
 * `""` (its zero value) instead, matching `encoding/json`'s slice-element decoding.
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

/** Reads the optional `ext` boolean field, throwing {@link jwkStructFieldTypeMismatch} when present with a non-boolean value. */
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

/** Every plain string JWK field except `alg`, which has its own allowlist validation and is checked separately by {@link assertNoMalformedDuplicateJwkField}. */
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
 * Advances past one JSON value starting at `text[start]`, returning the index just past it.
 * Tracks string-literal state so structural characters inside a string never affect nesting
 * depth. Assumes `text` is already valid JSON (called only after a successful `JSON.parse`).
 */
function skipJsonValue(text: string, start: number): number {
  let i = start;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  const skipString = () => {
    i++;
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
 * Splits a JSON array literal into each top-level element's exact source substring, without
 * re-serializing through `JSON.stringify` (which would erase a duplicate key) — used by
 * {@link readSigningKeysFile} for {@link assertNoMalformedDuplicateJwkField}.
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
 * Returns every top-level field of a JSON object literal, keyed by lowercased name, with every
 * occurrence's raw source text in source order — including case-variant duplicates (`KID`/`kid`)
 * that `JSON.parse` would otherwise collapse to just the last one.
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
 * Rejects an earlier malformed duplicate JWK field even though `JSON.parse` keeps only
 * the last occurrence, matching `encoding/json`'s first-mismatch-wins duplicate-key
 * handling; `alg` also fails on an earlier disallowed value even if a later one is valid.
 */
export function assertNoMalformedDuplicateJwkField(objectText: string): void {
  const occurrences = findTopLevelObjectFieldOccurrences(objectText);

  const alg = occurrences.get("alg");
  if (alg !== undefined && alg.length >= 2) {
    for (const rawValue of alg) {
      const checked = readOptionalString({ alg: JSON.parse(rawValue) }, "alg");
      assertDecodableJwkAlgorithm(checked);
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
 * {@link readSigningKeysFile} for that).
 */
export const resolveSigningKeysConfigPaths = Effect.fnUntraced(function* <E>(
  cwd: string,
  onConfigParseError: (message: string) => E,
) {
  const path = yield* Path.Path;
  // Loads the dotenv cascade explicitly before `loadCliConfig` decodes `env(...)` TOML
  // references — `loadCliConfig`'s own internal env resolution covers only
  // `supabase/.env[.local]`, not `.env.<SUPABASE_ENV>[.local]` or `<workdir>/.env`.
  const projectEnv = yield* loadCliProjectEnvironment({
    cwd,
    baseEnv: process.env,
    search: false,
    skipEnvLocal: (process.env["SUPABASE_ENV"] || "development") === "test",
  }).pipe(
    Effect.mapError((cause) => onConfigParseError(`failed to read config: ${String(cause)}`)),
  );
  const projectEnvValues = yield* Effect.try({
    try: () => resolveProjectEnvironmentValues(projectEnv, cwd),
    catch: (cause) => onConfigParseError(`failed to read config: ${String(cause)}`),
  });
  const loaded = yield* loadCliConfig(cwd, {
    cliProjectEnv: projectEnv !== null ? { ...projectEnv, values: projectEnvValues } : undefined,
    goViperCompat: true,
    // `cwd` is already resolved (`CommandSettings.workdir`); `search: false` avoids climbing
    // again, which would otherwise find an ancestor project's config when `--workdir` points
    // below another project's root. `tomlOnly: true` because there is no JSON config format.
    search: false,
    tomlOnly: true,
  }).pipe(
    Effect.catchTag("CliConfigParseError", (cause) =>
      Effect.fail(onConfigParseError(`failed to parse ${cause.path}: ${String(cause.cause)}`)),
    ),
  );
  if (loaded === null) {
    return {
      configDisplayPath: path.join("supabase", "config.toml"),
      authEnabled: true,
      signingKeysPath: Option.none(),
    } satisfies GenSigningKeysConfigPaths;
  }

  // Display the config path relative to the project root; `loaded.path` is always absolute.
  const projectRoot = path.dirname(path.dirname(loaded.path));
  const configDisplayPath = path.relative(projectRoot, loaded.path);
  const authEnabled = loaded.config.auth.enabled;

  const configuredPath = loaded.config.auth.signing_keys_path;
  if (configuredPath === undefined || configuredPath.length === 0) {
    return {
      configDisplayPath,
      authEnabled,
      signingKeysPath: Option.none(),
    } satisfies GenSigningKeysConfigPaths;
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
  } satisfies GenSigningKeysConfigPaths;
});

/**
 * Reads and JSON-decodes a `[auth].signing_keys_path` file into an array of JWK-shaped
 * records, validating the `alg` allowlist and rejecting malformed duplicate fields (see
 * {@link assertNoMalformedDuplicateJwkField}) with the established error text.
 */
export const readSigningKeysFile = Effect.fnUntraced(function* <E1, E2>(
  actualPath: string,
  onReadError: (message: string) => E1,
  onDecodeError: (message: string) => E2,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs
    .readFileString(actualPath)
    .pipe(Effect.mapError((cause) => onReadError(`failed to read signing keys: ${String(cause)}`)));
  const decoded = yield* Effect.try({
    // Parses only the first JSON value's span and ignores trailing content, since plain
    // `JSON.parse` would otherwise error on trailing bytes that a single-value decode
    // should silently ignore.
    try: () => JSON.parse(raw.slice(0, skipJsonValue(raw, 0))),
    catch: (cause) => onDecodeError(`failed to decode signing keys: ${String(cause)}`),
  });
  if (!Array.isArray(decoded)) {
    return yield* Effect.fail(
      onDecodeError("failed to decode signing keys: expected a JSON array"),
    );
  }
  // A `null` array element normalizes to `{}` (every field absent) rather than being
  // rejected here, matching `encoding/json`'s zero-value decoding of a `null` struct element.
  // Downstream signing may still fail on an all-absent key; this step never rejects it.
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
      // The `alg` allowlist check runs case-insensitively, matching decode-time validation.
      const alg = resolveJwkFieldValue(record, "alg");
      assertDecodableJwkAlgorithm(typeof alg === "string" ? alg : undefined);
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
  return normalized as ReadonlyArray<StoredSigningKeyJwk>;
});
