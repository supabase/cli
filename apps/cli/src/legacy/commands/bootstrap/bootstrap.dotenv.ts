import type { ApiKeyResponse } from "@supabase/api/effect";

import { apiKeysToEnv } from "../../shared/legacy-api-keys.format.ts";
import { type LegacyDbConfig, toPostgresUrl } from "./bootstrap.pgconfig.ts";

type ApiKey = typeof ApiKeyResponse.Type;

// Env-var keys bootstrap writes / derives. Mirrors the constants in
// `apps/cli-go/internal/bootstrap/bootstrap.go:131-150`.
const SUPABASE_SERVICE_ROLE_KEY = "SUPABASE_SERVICE_ROLE_KEY";
const SUPABASE_ANON_KEY = "SUPABASE_ANON_KEY";
const SUPABASE_URL = "SUPABASE_URL";
const POSTGRES_URL = "POSTGRES_URL";
// Derived keys (only populated when present in .env.example).
const POSTGRES_PRISMA_URL = "POSTGRES_PRISMA_URL";
const POSTGRES_URL_NON_POOLING = "POSTGRES_URL_NON_POOLING";
const POSTGRES_USER = "POSTGRES_USER";
const POSTGRES_HOST = "POSTGRES_HOST";
const POSTGRES_PASSWORD = "POSTGRES_PASSWORD";
const POSTGRES_DATABASE = "POSTGRES_DATABASE";
const NEXT_PUBLIC_SUPABASE_ANON_KEY = "NEXT_PUBLIC_SUPABASE_ANON_KEY";
const NEXT_PUBLIC_SUPABASE_URL = "NEXT_PUBLIC_SUPABASE_URL";
const EXPO_PUBLIC_SUPABASE_ANON_KEY = "EXPO_PUBLIC_SUPABASE_ANON_KEY";
const EXPO_PUBLIC_SUPABASE_URL = "EXPO_PUBLIC_SUPABASE_URL";

/**
 * Reproduces Go's `writeDotEnv` env-map construction (`bootstrap.go:166-243`).
 *
 * Seeds the api-key env vars (`SUPABASE_<NAME>_KEY`), the project `SUPABASE_URL`,
 * and the pooled `POSTGRES_URL` (transaction mode, port 6543). When a `.env.example`
 * map is supplied, each of its keys is merged via Go's switch: the four seeded keys
 * are preserved, the derived `POSTGRES_*` / `NEXT_PUBLIC_*` / `EXPO_PUBLIC_*` keys are
 * computed from the db config + seeded values, and any other key copies its example
 * value verbatim.
 */
export function buildDotEnv(
  keys: ReadonlyArray<ApiKey>,
  config: LegacyDbConfig,
  supabaseUrl: string,
  example: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const initial = apiKeysToEnv(keys);
  initial[SUPABASE_URL] = supabaseUrl;
  initial[POSTGRES_URL] = toPostgresUrl({ ...config, port: 6543 });

  if (example === undefined) {
    return initial;
  }

  for (const [key, value] of Object.entries(example)) {
    switch (key) {
      // Seeded keys win over any example value.
      case SUPABASE_SERVICE_ROLE_KEY:
      case SUPABASE_ANON_KEY:
      case SUPABASE_URL:
      case POSTGRES_URL:
        break;
      case POSTGRES_PRISMA_URL:
        initial[key] = initial[POSTGRES_URL] ?? "";
        break;
      case POSTGRES_URL_NON_POOLING:
        initial[key] = toPostgresUrl(config);
        break;
      case POSTGRES_USER:
        initial[key] = config.user;
        break;
      case POSTGRES_HOST:
        initial[key] = config.host;
        break;
      case POSTGRES_PASSWORD:
        initial[key] = config.password;
        break;
      case POSTGRES_DATABASE:
        initial[key] = config.database;
        break;
      case NEXT_PUBLIC_SUPABASE_ANON_KEY:
      case EXPO_PUBLIC_SUPABASE_ANON_KEY:
        initial[key] = initial[SUPABASE_ANON_KEY] ?? "";
        break;
      case NEXT_PUBLIC_SUPABASE_URL:
      case EXPO_PUBLIC_SUPABASE_URL:
        initial[key] = initial[SUPABASE_URL] ?? "";
        break;
      default:
        initial[key] = value;
    }
  }
  return initial;
}

// godotenv's `doubleQuoteSpecialChars` (`joho/godotenv/godotenv.go`): backslash,
// newline, carriage return, double-quote, `!`, `$`, backtick.
const DOUBLE_QUOTE_SPECIAL = ["\\", "\n", "\r", '"', "!", "$", "`"] as const;

function doubleQuoteEscape(line: string): string {
  let out = line;
  for (const char of DOUBLE_QUOTE_SPECIAL) {
    const replacement = char === "\n" ? "\\n" : char === "\r" ? "\\r" : `\\${char}`;
    out = out.replaceAll(char, replacement);
  }
  return out;
}

// strconv.Atoi surface: optional sign + base-10 digits, parsed within int range.
const INTEGER_PATTERN = /^[+-]?\d+$/;

/**
 * Reproduces `godotenv.Marshal`: each entry renders as `KEY=<int>` when the value
 * parses as an integer (Go's `strconv.Atoi` + `%d`), otherwise `KEY="<escaped>"`.
 * Lines are sorted lexicographically (Go sorts the rendered lines, which orders
 * by key) and joined with `\n` (no trailing newline).
 */
export function marshalDotEnv(env: Readonly<Record<string, string>>): string {
  const lines: Array<string> = [];
  for (const [key, value] of Object.entries(env)) {
    if (INTEGER_PATTERN.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) {
        lines.push(`${key}=${parsed}`);
        continue;
      }
    }
    lines.push(`${key}="${doubleQuoteEscape(value)}"`);
  }
  lines.sort();
  return lines.join("\n");
}

// godotenv.Parse-compatible enough for `.env.example`: `KEY=VALUE` / `KEY="VALUE"`
// lines, `#` comments, blank lines. A line with an empty / invalid variable name
// throws (Go's `godotenv.Parse` surfaces `unexpected character ... in variable name`).
const EXPORT_PREFIX = /^\s*export\s+/;

/**
 * Minimal godotenv parser for `.env.example`. Returns the parsed key/value map.
 * Throws an `Error` whose message mirrors Go's parser for a malformed variable
 * name so the caller can surface the same failure (`"!="` → unexpected character).
 */
export function parseDotEnv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.replace(EXPORT_PREFIX, "").trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      const offending = line.slice(0, eq < 0 ? line.length : eq + 1);
      throw new Error(
        `unexpected character "${line[0] ?? ""}" in variable name near "${offending}"`,
      );
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
      throw new Error(`unexpected character "${key[0] ?? ""}" in variable name near "${line}"`);
    }
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      // godotenv expands escapes inside double-quoted values: `\n` / `\r` become
      // real newlines, and a backslash before any other char (except `$`) is
      // dropped (`\"` -> `"`, `\\` -> `\`).
      value = value
        .slice(1, -1)
        .replaceAll("\\n", "\n")
        .replaceAll("\\r", "\r")
        .replace(/\\([^$])/g, "$1");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      // Single-quoted values are taken literally (no escape expansion).
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
