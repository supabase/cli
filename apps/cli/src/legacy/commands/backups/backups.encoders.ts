import type { V1ListAllBackupsOutput } from "@supabase/api/effect";
import { stringify as stringifyToml } from "smol-toml";
import { stringify as stringifyYaml } from "yaml";

/**
 * Reproduces Go's `encoding/json` output for `V1BackupsResponse`:
 *   - Top-level and nested struct fields serialize in alphabetical declaration order.
 *   - Go emits `null` for a nil `Backups` slice. The TS schema decodes both `null`
 *     and `[]` upstream into `[]`, so we re-substitute `null` for empty arrays
 *     to match the common PITR-only response shape.
 */
export function encodeGoJson(response: typeof V1ListAllBackupsOutput.Type): string {
  const source = response.backups.length > 0 ? response : { ...response, backups: null };
  return JSON.stringify(sortKeysDeep(source), null, 2) + "\n";
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function encodeYaml(value: unknown): string {
  return stringifyYaml(value);
}

export function encodeToml(value: unknown): string {
  // smol-toml refuses top-level non-object values; wrap if needed.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return stringifyToml({ value });
  }
  return stringifyToml(value as Record<string, unknown>);
}

/**
 * Reproduces Go's `utils.ToEnvMap` + `godotenv.Marshal` byte shape for the
 * Supabase CLI's `--output env` mode (see `apps/cli-go/internal/utils/output.go:86-107`).
 *
 *   - Viper's `AllKeys()` descends into nested maps using dotted paths; the loop
 *     then `strings.ToUpper(strings.ReplaceAll(k, ".", "_"))` produces SCREAMING_SNAKE_CASE keys.
 *   - Viper does **not** descend into slices. An array value lands as a single
 *     leaf whose `GetString` rendering is the empty string — so e.g.
 *     `{backups: [{...}, {...}]}` becomes one `BACKUPS=""` entry, not indexed leaves.
 *   - Integer-parseable values are emitted unquoted (`KEY=123`), matching
 *     `godotenv.Marshal`'s `strconv.Atoi` branch. Everything else is double-quoted
 *     with `"` / `\\` escaped, matching the `fmt.Sprintf("%q", ...)` branch.
 *   - Lines are sorted lexicographically by key, then joined with `\n`.
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
    // Go's viper does not descend into slices — the entire array collapses to a
    // single empty-string leaf at the array's parent key.
    if (prefix.length > 0) out[toEnvKey(prefix)] = "";
    return out;
  }
  if (typeof value === "object") {
    // Go's viper.AllKeys() omits empty nested maps entirely (unlike empty
    // slices, which leave a single empty-string leaf). Match that — recurse
    // into populated maps; emit nothing for `{}`.
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

// strconv.Atoi accepts an optional +/- sign followed by base-10 digits. Match
// that surface so integer values flow through Go's unquoted `%d` branch.
const INTEGER_PATTERN = /^[+-]?\d+$/;

function formatEnvValue(value: string): string {
  if (INTEGER_PATTERN.test(value)) {
    const parsed = Number(value);
    // Mirror godotenv's `%d` formatting (round-trip through int — drops a leading
    // `+` and any leading zeros, matching Go's strconv.Atoi + fmt.Sprintf("%d").
    if (Number.isSafeInteger(parsed)) {
      return String(parsed);
    }
  }
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${escaped}"`;
}
