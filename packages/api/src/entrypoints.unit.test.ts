import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import * as effectModule from "./effect.ts";
import { createApiClient as createNodeApiClient } from "./node.ts";

describe("@supabase/api entrypoints", () => {
  test("exports the generated contracts without embedding the OpenAPI document", () => {
    expect(effectModule.operationDefinitions.v1CreateAProject.method).toBe("POST");
    expect(effectModule.openApiOperationIdMap["v1-create-a-project"]).toBe("v1CreateAProject");
    expect(effectModule.V1CreateAProjectInput).toBeDefined();
    expect("SupabaseApiClient" in effectModule).toBe(false);
    expect("makeSupabaseApiClient" in effectModule).toBe(false);
    expect("supabaseApiClientLayer" in effectModule).toBe(false);
    expect("v1ListAllProjects" in effectModule).toBe(false);
  });

  test("exports runtime-specific client builders", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const bunSource = readFileSync(join(srcDir, "bun.ts"), "utf8");

    expect(bunSource).toContain("export async function createApiClient");
    expect(typeof createNodeApiClient).toBe("function");
    expect(typeof effectModule.makeApiClient).toBe("function");
    expect(effectModule.ApiConfig).toBeDefined();
    expect(effectModule.apiConfigLayer).toBeDefined();
    expect(effectModule.DEFAULT_SUPABASE_API_URL).toBe("https://api.supabase.com");
    expect(bunSource).not.toContain("clientLayer");
  });

  test("does not generate separate promise or standalone operation artifacts", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    expect(existsSync(join(srcDir, "generated/promise-client.ts"))).toBe(false);
    expect(existsSync(join(srcDir, "generated/effect-operations.ts"))).toBe(false);
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
    expect(Object.keys(effectModule.openApiOperationIdMap)).toHaveLength(
      Object.keys(effectModule.operationDefinitions).length,
    );
    expect(effectModule.openApiOperationIdMap["v1-authorize-user"]).toBe("v1AuthorizeUser");
    expect(effectModule.openApiOperationIdMap["v1-diff-a-branch"]).toBe("v1DiffABranch");
    expect(effectModule.openApiOperationIdMap["v1-list-jit-access"]).toBe("v1ListJitAccess");
  });
});
