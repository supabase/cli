import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { createApiClient as createBunApiClient, clientLayer as bunClientLayer } from "./bun.ts";
import {
  ApiConfig,
  apiConfigLayer,
  DEFAULT_SUPABASE_API_URL,
  makeApiClient,
  makeSupabaseApiClient,
  openApiOperationIdMap,
  operationDefinitions,
  SupabaseApiClient,
  V1CreateAProjectInput,
} from "./effect.ts";
import { createApiClient as createNodeApiClient, clientLayer as nodeClientLayer } from "./node.ts";

describe("@supabase/api entrypoints", () => {
  test("exports the generated contracts without embedding the OpenAPI document", () => {
    expect(operationDefinitions.v1CreateAProject.method).toBe("POST");
    expect(openApiOperationIdMap["v1-create-a-project"]).toBe("v1CreateAProject");
    expect(V1CreateAProjectInput).toBeDefined();
    expect(SupabaseApiClient).toBeDefined();
  });

  test("exports runtime-specific client builders", () => {
    expect(typeof bunClientLayer).toBe("function");
    expect(typeof createBunApiClient).toBe("function");
    expect(typeof nodeClientLayer).toBe("function");
    expect(typeof createNodeApiClient).toBe("function");
    expect(typeof makeApiClient).toBe("function");
    expect(typeof makeSupabaseApiClient).toBe("function");
    expect(ApiConfig).toBeDefined();
    expect(apiConfigLayer).toBeDefined();
    expect(DEFAULT_SUPABASE_API_URL).toBe("https://api.supabase.com");
  });

  test("does not generate a separate promise-client artifact", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    expect(existsSync(join(srcDir, "generated/promise-client.ts"))).toBe(false);
  });

  test("ships the OpenAPI spec as a json subpath artifact", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const packageJson = JSON.parse(readFileSync(join(srcDir, "../package.json"), "utf8")) as {
      readonly exports: Record<string, string | Record<string, string>>;
    };
    const openApiDocument = JSON.parse(
      readFileSync(join(srcDir, "generated/openapi.json"), "utf8"),
    ) as { readonly openapi: string };

    expect(packageJson.exports["."]).toEqual({
      bun: "./src/bun.ts",
      default: "./src/node.ts",
    });
    expect(packageJson.exports["./effect"]).toBe("./src/effect.ts");
    expect(packageJson.exports["./openapi.json"]).toBe("./src/generated/openapi.json");
    expect(packageJson.exports["./bun"]).toBeUndefined();
    expect(packageJson.exports["./node"]).toBeUndefined();
    expect(openApiDocument.openapi).toBe("3.0.0");
  });

  test("exports a stable raw OpenAPI operation id map", () => {
    expect(Object.keys(openApiOperationIdMap)).toHaveLength(
      Object.keys(operationDefinitions).length,
    );
    expect(openApiOperationIdMap["v1-authorize-user"]).toBe("v1AuthorizeUser");
    expect(openApiOperationIdMap["v1-diff-a-branch"]).toBe("v1DiffABranch");
    expect(openApiOperationIdMap["v1-list-jit-access"]).toBe("v1ListJitAccess");
  });
});
