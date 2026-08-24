import { BunPath } from "@effect/platform-bun";
import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import * as EffectPath from "effect/Path";

import {
  legacyBuildStudioContainerSpec,
  legacyBuildStudioEnv,
  type LegacyBuildStudioEnvInput,
} from "./studio.service.ts";

const testPath = Effect.runSync(EffectPath.Path.pipe(Effect.provide(BunPath.layer)));

const baseEnvInput: LegacyBuildStudioEnvInput = {
  path: testPath,
  dbPassword: "postgres",
  workdir: "/project",
  containerSnippetsPath: "/project/supabase/.temp/snippets",
  cliVersion: "test-version",
  pgMetaContainerName: "test-pgmeta",
  kongContainerName: "test-kong",
  logflareContainerName: "test-logflare",
  studioApiUrl: "http://127.0.0.1:54321",
  jwtSecret: "jwt-secret",
  anonKey: "anon-key",
  serviceRoleKey: "service-role-key",
  publishableKey: "sb_publishable_test",
  secretKey: "sb_secret_test",
  s3AccessKeyId: "s3-access-key",
  s3SecretAccessKey: "s3-secret-key",
  openaiApiKey: undefined,
  apiSchemas: ["public", "graphql_public"],
  apiExtraSearchPath: ["public", "extensions"],
  apiMaxRows: 1000,
  analyticsEnabled: true,
  analyticsBackend: "postgres",
};

describe("legacyBuildStudioEnv", () => {
  test("mirrors Go's TestBuildStudioEnv fixture", () => {
    const env = legacyBuildStudioEnv(baseEnvInput);

    // The exact 8 assertions this fixture makes.
    expect(env["SUPABASE_ANON_KEY"]).toBe("anon-key");
    expect(env["SUPABASE_SERVICE_KEY"]).toBe("service-role-key");
    expect(env["SUPABASE_PUBLISHABLE_KEY"]).toBe("sb_publishable_test");
    expect(env["SUPABASE_SECRET_KEY"]).toBe("sb_secret_test");
    expect(env["S3_PROTOCOL_ACCESS_KEY_ID"]).toBe("s3-access-key");
    expect(env["S3_PROTOCOL_ACCESS_KEY_SECRET"]).toBe("s3-secret-key");
    expect(env["SUPABASE_URL"]).toBe("http://test-kong:8000");
    expect(env["STUDIO_PG_META_URL"]).toBe("http://test-pgmeta:8080");

    // Every other key `legacyBuildStudioEnv` emits, covered here for full
    // parity.
    expect(env).toEqual({
      CURRENT_CLI_VERSION: "test-version",
      STUDIO_PG_META_URL: "http://test-pgmeta:8080",
      POSTGRES_PASSWORD: "postgres",
      SUPABASE_URL: "http://test-kong:8000",
      SUPABASE_PUBLIC_URL: "http://127.0.0.1:54321",
      AUTH_JWT_SECRET: "jwt-secret",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_KEY: "service-role-key",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      S3_PROTOCOL_ACCESS_KEY_ID: "s3-access-key",
      S3_PROTOCOL_ACCESS_KEY_SECRET: "s3-secret-key",
      LOGFLARE_PRIVATE_ACCESS_TOKEN: "api-key",
      OPENAI_API_KEY: "",
      PGRST_DB_SCHEMAS: "public,graphql_public",
      PGRST_DB_EXTRA_SEARCH_PATH: "public,extensions",
      PGRST_DB_MAX_ROWS: "1000",
      LOGFLARE_URL: "http://test-logflare:4000",
      NEXT_PUBLIC_ENABLE_LOGS: "true",
      NEXT_ANALYTICS_BACKEND_PROVIDER: "postgres",
      EDGE_FUNCTIONS_MANAGEMENT_FOLDER: "/project/supabase/functions",
      SNIPPETS_MANAGEMENT_FOLDER: "/project/supabase/.temp/snippets",
      HOSTNAME: "0.0.0.0",
      POSTGRES_USER_READ_WRITE: "postgres",
    });
  });

  test("LOGFLARE_PRIVATE_ACCESS_TOKEN is always Go's hardcoded 'api-key', regardless of input", () => {
    // `analytics.api_key` isn't a `config.toml`-configurable field —
    // there is no input field for it at all.
    const env = legacyBuildStudioEnv(baseEnvInput);
    expect(env["LOGFLARE_PRIVATE_ACCESS_TOKEN"]).toBe("api-key");
  });

  test("falls back OPENAI_API_KEY to an empty string when unset", () => {
    const env = legacyBuildStudioEnv({ ...baseEnvInput, openaiApiKey: undefined });
    expect(env["OPENAI_API_KEY"]).toBe("");
  });

  test("passes through a configured OPENAI_API_KEY", () => {
    const env = legacyBuildStudioEnv({ ...baseEnvInput, openaiApiKey: "sk-test" });
    expect(env["OPENAI_API_KEY"]).toBe("sk-test");
  });

  test('reflects analyticsEnabled/analyticsBackend verbatim (Go\'s fmt.Sprintf("%v", ...))', () => {
    const env = legacyBuildStudioEnv({
      ...baseEnvInput,
      analyticsEnabled: false,
      analyticsBackend: "bigquery",
    });
    expect(env["NEXT_PUBLIC_ENABLE_LOGS"]).toBe("false");
    expect(env["NEXT_ANALYTICS_BACKEND_PROVIDER"]).toBe("bigquery");
  });

  test("EDGE_FUNCTIONS_MANAGEMENT_FOLDER is workdir/supabase/functions in Docker-path form", () => {
    const env = legacyBuildStudioEnv({
      ...baseEnvInput,
      workdir: "/Users/me/my-project",
    });
    expect(env["EDGE_FUNCTIONS_MANAGEMENT_FOLDER"]).toBe("/Users/me/my-project/supabase/functions");
  });
});

describe("legacyBuildStudioContainerSpec", () => {
  const baseSpecInput = {
    path: testPath,
    image: "supabase/studio:2026.07.07-sha-a6a04f2",
    containerName: "supabase_studio_proj",
    networkId: "supabase_network_proj",
    port: 54323,
    functionBinds: [] as ReadonlyArray<string>,
    env: baseEnvInput,
  };

  test("assembles the full container spec, wiring pg-meta's own container name into STUDIO_PG_META_URL", () => {
    const spec = legacyBuildStudioContainerSpec(baseSpecInput);

    expect(spec.image).toBe("supabase/studio:2026.07.07-sha-a6a04f2");
    expect(spec.containerName).toBe("supabase_studio_proj");
    expect(spec.networkId).toBe("supabase_network_proj");
    expect(spec.networkAliases).toEqual(["studio"]);
    expect(spec.restartPolicy).toBe("unless-stopped");
    expect(spec.labels).toEqual({});
    expect(spec.ports).toEqual([{ hostPort: "54323", containerPort: "3000" }]);
    expect(spec.healthcheck).toEqual({
      test: [
        "CMD-SHELL",
        `node --eval="fetch('http://127.0.0.1:3000/api/platform/profile').then((r) => {if (!r.ok) throw new Error(r.status)})"`,
      ],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    });

    // pg-meta URL wiring: a distinct `pgMetaContainerName` (resolved by the
    // caller via `legacyServiceContainerName("pg_meta", projectId)`) flows
    // through to STUDIO_PG_META_URL exactly like it does in
    // `legacyBuildStudioEnv`.
    expect(spec.env["STUDIO_PG_META_URL"]).toBe("http://test-pgmeta:8080");
  });

  test("derives the snippets bind from env.workdir and includes it alongside functionBinds", () => {
    const spec = legacyBuildStudioContainerSpec({
      ...baseSpecInput,
      functionBinds: ["/project/supabase/functions/hello:/home/deno/functions/hello:ro"],
    });

    expect(spec.binds).toEqual([
      "/project/supabase/functions/hello:/home/deno/functions/hello:ro",
      "/project/supabase/snippets:/project/supabase/snippets:rw",
    ]);
    // The snippets bind's container-side path also backs SNIPPETS_MANAGEMENT_FOLDER.
    expect(spec.env["SNIPPETS_MANAGEMENT_FOLDER"]).toBe("/project/supabase/snippets");
  });

  test("dedupes the snippets bind against an identical functionBinds entry (Go's utils.RemoveDuplicates)", () => {
    const spec = legacyBuildStudioContainerSpec({
      ...baseSpecInput,
      functionBinds: ["/project/supabase/snippets:/project/supabase/snippets:rw"],
    });

    expect(spec.binds).toEqual(["/project/supabase/snippets:/project/supabase/snippets:rw"]);
  });
});
