import { BunPath } from "@effect/platform-bun";
import { Effect, Path } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";

import {
  buildStudioContainerSpec,
  buildStudioEnv,
  type BuildStudioEnvInput,
} from "./studio.service.ts";

const baseEnvInput: BuildStudioEnvInput = {
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

describe("buildStudioEnv", () => {
  it.effect("mirrors Go's TestBuildStudioEnv fixture", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const env = buildStudioEnv(baseEnvInput, path);

      expect(env["SUPABASE_ANON_KEY"]).toBe("anon-key");
      expect(env["SUPABASE_SERVICE_KEY"]).toBe("service-role-key");
      expect(env["SUPABASE_PUBLISHABLE_KEY"]).toBe("sb_publishable_test");
      expect(env["SUPABASE_SECRET_KEY"]).toBe("sb_secret_test");
      expect(env["S3_PROTOCOL_ACCESS_KEY_ID"]).toBe("s3-access-key");
      expect(env["S3_PROTOCOL_ACCESS_KEY_SECRET"]).toBe("s3-secret-key");
      expect(env["SUPABASE_URL"]).toBe("http://test-kong:8000");
      expect(env["STUDIO_PG_META_URL"]).toBe("http://test-pgmeta:8080");

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
    }).pipe(Effect.provide(BunPath.layer));
  });

  it.effect(
    "LOGFLARE_PRIVATE_ACCESS_TOKEN is always Go's hardcoded 'api-key', regardless of input",
    () => {
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = buildStudioEnv(baseEnvInput, path);
        expect(env["LOGFLARE_PRIVATE_ACCESS_TOKEN"]).toBe("api-key");
      }).pipe(Effect.provide(BunPath.layer));
    },
  );

  it.effect("falls back OPENAI_API_KEY to an empty string when unset", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const env = buildStudioEnv({ ...baseEnvInput, openaiApiKey: undefined }, path);
      expect(env["OPENAI_API_KEY"]).toBe("");
    }).pipe(Effect.provide(BunPath.layer));
  });

  it.effect("passes through a configured OPENAI_API_KEY", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const env = buildStudioEnv({ ...baseEnvInput, openaiApiKey: "sk-test" }, path);
      expect(env["OPENAI_API_KEY"]).toBe("sk-test");
    }).pipe(Effect.provide(BunPath.layer));
  });

  it.effect(
    'reflects analyticsEnabled/analyticsBackend verbatim (Go\'s fmt.Sprintf("%v", ...))',
    () => {
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = buildStudioEnv(
          {
            ...baseEnvInput,
            analyticsEnabled: false,
            analyticsBackend: "bigquery",
          },
          path,
        );
        expect(env["NEXT_PUBLIC_ENABLE_LOGS"]).toBe("false");
        expect(env["NEXT_ANALYTICS_BACKEND_PROVIDER"]).toBe("bigquery");
      }).pipe(Effect.provide(BunPath.layer));
    },
  );

  it.effect(
    "EDGE_FUNCTIONS_MANAGEMENT_FOLDER is workdir/supabase/functions in Docker-path form",
    () => {
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = buildStudioEnv(
          {
            ...baseEnvInput,
            workdir: "/Users/me/my-project",
          },
          path,
        );
        expect(env["EDGE_FUNCTIONS_MANAGEMENT_FOLDER"]).toBe(
          "/Users/me/my-project/supabase/functions",
        );
      }).pipe(Effect.provide(BunPath.layer));
    },
  );
});

describe("buildStudioContainerSpec", () => {
  const baseSpecInput = {
    image: "supabase/studio:2026.07.07-sha-a6a04f2",
    containerName: "supabase_studio_proj",
    networkId: "supabase_network_proj",
    port: 54323,
    functionBinds: [] as ReadonlyArray<string>,
    env: baseEnvInput,
  };

  it.effect(
    "assembles the full container spec, wiring pg-meta's own container name into STUDIO_PG_META_URL",
    () => {
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const spec = buildStudioContainerSpec(baseSpecInput, path);

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

        expect(spec.env["STUDIO_PG_META_URL"]).toBe("http://test-pgmeta:8080");
      }).pipe(Effect.provide(BunPath.layer));
    },
  );

  it.effect(
    "derives the snippets bind from env.workdir and includes it alongside functionBinds",
    () => {
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const spec = buildStudioContainerSpec(
          {
            ...baseSpecInput,
            functionBinds: ["/project/supabase/functions/hello:/home/deno/functions/hello:ro"],
          },
          path,
        );

        expect(spec.binds).toEqual([
          "/project/supabase/functions/hello:/home/deno/functions/hello:ro",
          "/project/supabase/snippets:/project/supabase/snippets:rw",
        ]);
        expect(spec.env["SNIPPETS_MANAGEMENT_FOLDER"]).toBe("/project/supabase/snippets");
      }).pipe(Effect.provide(BunPath.layer));
    },
  );

  it.effect(
    "dedupes the snippets bind against an identical functionBinds entry (Go's utils.RemoveDuplicates)",
    () => {
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const spec = buildStudioContainerSpec(
          {
            ...baseSpecInput,
            functionBinds: ["/project/supabase/snippets:/project/supabase/snippets:rw"],
          },
          path,
        );

        expect(spec.binds).toEqual(["/project/supabase/snippets:/project/supabase/snippets:rw"]);
      }).pipe(Effect.provide(BunPath.layer));
    },
  );
  it.effect("translates Windows function and snippet mounts for the container", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const spec = buildStudioContainerSpec(
        { ...baseSpecInput, env: { ...baseEnvInput, workdir: "C:\\project" } },
        path,
      );
      expect(spec.env.EDGE_FUNCTIONS_MANAGEMENT_FOLDER).toBe("/project/supabase/functions");
      expect(spec.env.SNIPPETS_MANAGEMENT_FOLDER).toBe("/project/supabase/snippets");
      expect(spec.binds).toContain("C:\\project\\supabase\\snippets:/project/supabase/snippets:rw");
    }).pipe(Effect.provide(BunPath.layerWin32)),
  );
});
