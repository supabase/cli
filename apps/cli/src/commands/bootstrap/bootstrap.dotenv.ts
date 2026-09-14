import type { ApiKeyResponse } from "@supabase/api/effect";

import { apiKeysToEnv } from "../../command-internal/api-keys.format.ts";
import { type DbConfig, toPostgresUrl } from "./bootstrap.pgconfig.ts";

type ApiKey = typeof ApiKeyResponse.Type;

const SUPABASE_SERVICE_ROLE_KEY = "SUPABASE_SERVICE_ROLE_KEY";
const SUPABASE_ANON_KEY = "SUPABASE_ANON_KEY";
const SUPABASE_URL = "SUPABASE_URL";
const POSTGRES_URL = "POSTGRES_URL";
// Only populated when present in .env.example.
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
 * Builds the bootstrap `.env` map: seeds the api-key vars, `SUPABASE_URL`, and the pooled
 * `POSTGRES_URL` (transaction mode, port 6543). When `example` (from `.env.example`) is given,
 * seeded keys win, `POSTGRES_*`/`NEXT_PUBLIC_*`/`EXPO_PUBLIC_*` keys are derived from `config`
 * and the seeded values, and every other key copies its example value verbatim.
 */
export function buildDotEnv(
  keys: ReadonlyArray<ApiKey>,
  config: DbConfig,
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

// Chars escaped in double-quoted values: backslash, newline, CR, double-quote, `!`, `$`, backtick.
const DOUBLE_QUOTE_SPECIAL = ["\\", "\n", "\r", '"', "!", "$", "`"] as const;

function doubleQuoteEscape(line: string): string {
  let out = line;
  for (const char of DOUBLE_QUOTE_SPECIAL) {
    const replacement = char === "\n" ? "\\n" : char === "\r" ? "\\r" : `\\${char}`;
    out = out.replaceAll(char, replacement);
  }
  return out;
}

// Optional sign plus base-10 digits, matching integer values that render unquoted.
const INTEGER_PATTERN = /^[+-]?\d+$/;

/**
 * Renders `.env` entries as `KEY=<int>` for integer-valued values, otherwise
 * `KEY="<escaped>"`, sorted lexicographically by key and joined with `\n` (no trailing
 * newline).
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
