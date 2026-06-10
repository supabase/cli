import type { ApiKeyResponse } from "@supabase/api/effect";
import { describe, expect, it } from "vitest";

import { buildDotEnv, marshalDotEnv } from "./bootstrap.dotenv.ts";
import type { LegacyDbConfig } from "./bootstrap.pgconfig.ts";

type ApiKey = typeof ApiKeyResponse.Type;

// Mirrors Go's `bootstrap_test.go::TestWriteEnv` fixtures.
const API_KEYS: ReadonlyArray<ApiKey> = [
  { name: "anon", api_key: "anonkey" },
  { name: "service_role", api_key: "servicekey" },
];

const DB_CONFIG: LegacyDbConfig = {
  host: "db.supabase.co",
  port: 5432,
  user: "admin",
  password: "password",
  database: "postgres",
};

const SUPABASE_URL = "https://testing.supabase.co";

describe("buildDotEnv + marshalDotEnv", () => {
  it("writes the api keys, project URL and pooled POSTGRES_URL", () => {
    const env = buildDotEnv(API_KEYS, DB_CONFIG, SUPABASE_URL, undefined);
    expect(marshalDotEnv(env)).toBe(
      `POSTGRES_URL="postgresql://admin:password@db.supabase.co:6543/postgres?connect_timeout=10"
SUPABASE_ANON_KEY="anonkey"
SUPABASE_SERVICE_ROLE_KEY="servicekey"
SUPABASE_URL="https://testing.supabase.co"`,
    );
  });

  it("merges the derived keys from a .env.example (every switch branch)", () => {
    const example: Record<string, string> = {
      POSTGRES_PRISMA_URL: "example",
      POSTGRES_URL_NON_POOLING: "example",
      POSTGRES_USER: "example",
      POSTGRES_HOST: "example",
      POSTGRES_PASSWORD: "example",
      POSTGRES_DATABASE: "example",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "example",
      NEXT_PUBLIC_SUPABASE_URL: "example",
      no_match: "example",
      SUPABASE_SERVICE_ROLE_KEY: "example",
      SUPABASE_ANON_KEY: "example",
      SUPABASE_URL: "example",
      POSTGRES_URL: "example",
    };
    const env = buildDotEnv(API_KEYS, DB_CONFIG, SUPABASE_URL, example);
    expect(marshalDotEnv(env)).toBe(
      `NEXT_PUBLIC_SUPABASE_ANON_KEY="anonkey"
NEXT_PUBLIC_SUPABASE_URL="https://testing.supabase.co"
POSTGRES_DATABASE="postgres"
POSTGRES_HOST="db.supabase.co"
POSTGRES_PASSWORD="password"
POSTGRES_PRISMA_URL="postgresql://admin:password@db.supabase.co:6543/postgres?connect_timeout=10"
POSTGRES_URL="postgresql://admin:password@db.supabase.co:6543/postgres?connect_timeout=10"
POSTGRES_URL_NON_POOLING="postgresql://admin:password@db.supabase.co:5432/postgres?connect_timeout=10"
POSTGRES_USER="admin"
SUPABASE_ANON_KEY="anonkey"
SUPABASE_SERVICE_ROLE_KEY="servicekey"
SUPABASE_URL="https://testing.supabase.co"
no_match="example"`,
    );
  });

  it("mirrors the EXPO_PUBLIC_* keys to the anon key and project URL", () => {
    const env = buildDotEnv(API_KEYS, DB_CONFIG, SUPABASE_URL, {
      EXPO_PUBLIC_SUPABASE_ANON_KEY: "example",
      EXPO_PUBLIC_SUPABASE_URL: "example",
    });
    expect(env["EXPO_PUBLIC_SUPABASE_ANON_KEY"]).toBe("anonkey");
    expect(env["EXPO_PUBLIC_SUPABASE_URL"]).toBe(SUPABASE_URL);
  });

  it("masks a nullable-null api key as ******", () => {
    const env = buildDotEnv(
      [{ name: "service_role", api_key: null }],
      DB_CONFIG,
      SUPABASE_URL,
      undefined,
    );
    expect(env["SUPABASE_SERVICE_ROLE_KEY"]).toBe("******");
  });
});

describe("marshalDotEnv", () => {
  it("emits integer-valued entries unquoted and escapes special characters", () => {
    expect(marshalDotEnv({ COUNT: "42", PATH: 'a"b\\c', NOTE: "hi!" })).toBe(
      `COUNT=42\nNOTE="hi\\!"\nPATH="a\\"b\\\\c"`,
    );
  });
});
