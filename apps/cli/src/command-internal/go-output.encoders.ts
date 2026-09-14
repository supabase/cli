import { stringify as stringifyToml } from "smol-toml";
import { stringify as stringifyYaml } from "yaml";

import { encodeGoJsonCompact, encodeGoJsonIndented } from "./go-json.ts";
import { goStringCompare } from "./go-struct-output.encoders.ts";

/**
 * Reproduces `json.Encoder` output for `-o json`: alphabetical key order, Go string escaping, and
 * a trailing newline.
 *
 * `nullForEmptyArrays` re-substitutes `null` for an empty array at the listed keys, for a schema
 * that decodes both `null` and `[]` to `[]` upstream (e.g. `backups list`'s `"backups": null`).
 */
export function encodeGoJson<T>(
  value: T,
  options?: { readonly nullForEmptyArrays?: ReadonlyArray<string> },
): string {
  let source: unknown = value;
  const nullKeys = options?.nullForEmptyArrays;
  if (
    nullKeys !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const record = value as Record<string, unknown>;
    const patched: Record<string, unknown> = { ...record };
    for (const key of nullKeys) {
      const v = record[key];
      if (Array.isArray(v) && v.length === 0) {
        patched[key] = null;
      }
    }
    source = patched;
  }
  return encodeGoJsonIndented(sortKeysDeep(source));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  // A plain object reorders integer-like string keys ("2", "10") into ascending numeric order on
  // enumeration; building a `Map` instead carries a lexicographic sort through to `go-json.ts`'s
  // `walk` intact, since `Map` iteration order is true insertion order.
  const sorted = new Map<string, unknown>();
  // JS's default string sort orders by UTF-16 code unit, which diverges from Go's byte/codepoint
  // order once an astral character (a UTF-16 surrogate pair) meets a high-BMP one.
  // `goStringCompare` reproduces Go's real map-key order instead — this matters here since `gen
  // bearer-jwt`'s custom claims flow through this same sort before signing.
  for (const key of Object.keys(value as Record<string, unknown>).sort(goStringCompare)) {
    const child = (value as Record<string, unknown>)[key];
    // Drop `undefined` properties here, matching `JSON.stringify`'s behavior (the Go-faithful
    // walker below would otherwise render them as `null`).
    if (child === undefined) continue;
    sorted.set(key, sortKeysDeep(child));
  }
  return sorted;
}

/**
 * Serializes an outbound API request body with sorted keys, Go string escaping, no indentation,
 * and no trailing newline, matching `json.Marshal`'s struct output.
 *
 * Used on the raw-HTTP code path (`sso add`/`sso update`) whose request bodies the cli-e2e replay
 * server compares by string equality against recorded bodies, so key order and escaping must
 * match exactly. {@link encodeGoJson} is the parallel for human-facing `--output json`.
 */
export function encodeGoStructJsonBody(value: unknown): string {
  return encodeGoJsonCompact(sortKeysDeep(value));
}

/**
 * YAML for map payloads (`branches get` envs, `sso info`, `status`, `postgres-config`). Struct
 * payloads must use `encodeGoYaml` in `go-struct-output.encoders.ts` instead, since Go's yaml.v3
 * derives keys from Go field names, not JSON tags.
 */
export function encodeYaml(value: unknown): string {
  return stringifyYaml(value);
}

/**
 * TOML for map payloads. Struct payloads must use `encodeGoToml` in
 * `go-struct-output.encoders.ts` instead, since BurntSushi emits PascalCase Go field names with
 * 2-space table indentation.
 */
export function encodeToml(value: unknown): string {
  // smol-toml refuses top-level non-object values; wrap if needed.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return stringifyToml({ value });
  }
  return stringifyToml(value as Record<string, unknown>);
}

/**
 * Reproduces the established `godotenv.Marshal` byte shape for `--output env`.
 *
 * Nested maps flatten to dotted paths, then uppercase with `.` replaced by `_`. Flattening does
 * not descend into slices: an array value becomes a single empty-string leaf. Integer-parseable
 * values are emitted unquoted; everything else is double-quoted with `"`/`\\` escaped. Lines sort
 * lexicographically by key.
 */
export function encodeEnv(value: unknown): string {
  const flat = flatten(value);
  const lines: string[] = [];
  const keys = Object.keys(flat).sort();
  for (const key of keys) {
    lines.push(`${key}=${formatEnvValue(flat[key] ?? "")}`);
  }
  return lines.join("\n");
}

function flatten(
  value: unknown,
  prefix = "",
  out: Record<string, string> = {},
): Record<string, string> {
  if (value === null || value === undefined) {
    if (prefix.length > 0) out[toEnvKey(prefix)] = "";
    return out;
  }
  if (Array.isArray(value)) {
    // Arrays don't flatten further — the whole array collapses to a single empty-string leaf.
    if (prefix.length > 0) out[toEnvKey(prefix)] = "";
    return out;
  }
  if (typeof value === "object") {
    // Empty nested maps emit nothing; only populated maps recurse.
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flatten(child, prefix.length === 0 ? key : `${prefix}.${key}`, out);
    }
    return out;
  }
  if (prefix.length > 0) {
    out[toEnvKey(prefix)] = stringifyScalar(value);
  }
  return out;
}

function toEnvKey(key: string): string {
  return key.replaceAll(".", "_").toUpperCase();
}

function stringifyScalar(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return String(value);
}

// An optional +/- sign followed by base-10 digits, so integer values flow through the unquoted
// branch below.
const INTEGER_PATTERN = /^[+-]?\d+$/;

function formatEnvValue(value: string): string {
  if (INTEGER_PATTERN.test(value)) {
    const parsed = Number(value);
    // Round-trip through Number to drop a leading `+` or leading zeros.
    if (Number.isSafeInteger(parsed)) {
      return String(parsed);
    }
  }
  // Escaping control characters (`\n`/`\r`/`\t`) prevents a multi-line value from becoming
  // multiple KEY=VALUE assignments when a downstream shell evals or sources the output.
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
}
