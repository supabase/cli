import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import * as Schema from "effect/Schema";
import { describe, expect, test } from "vitest";

import * as effectModule from "./effect.ts";
import { createApiClient as createNodeApiClient } from "./node.ts";

const readSource = (relativePath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* path.fromFileUrl(new URL("./", import.meta.url));
    return yield* fs.readFileString(path.join(root, relativePath));
  }).pipe(Effect.provide(BunServices.layer));

const sourceExists = (relativePath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* path.fromFileUrl(new URL("./", import.meta.url));
    return yield* fs.exists(path.join(root, relativePath));
  }).pipe(Effect.provide(BunServices.layer));

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

  test("exports runtime-specific client builders", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const bunSource = yield* readSource("bun.ts");
        expect(bunSource).toContain("export function createApiClient");
        expect(typeof createNodeApiClient).toBe("function");
        expect(typeof effectModule.makeApiClient).toBe("function");
        expect(effectModule.ApiConfig).toBeDefined();
        expect(effectModule.apiConfigLayer).toBeDefined();
        expect(effectModule.DEFAULT_SUPABASE_API_URL).toBe("https://api.supabase.com");
        expect(bunSource).not.toContain("clientLayer");
      }),
    ));

  test("does not generate separate promise or standalone operation artifacts", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* sourceExists("generated/promise-client.ts")).toBe(false);
        expect(yield* sourceExists("generated/effect-operations.ts")).toBe(false);
      }),
    ));

  test("ships the OpenAPI spec as a json subpath artifact", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const packageJsonUnknown = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Unknown),
        )(yield* readSource("../package.json"));
        const openApiDocumentUnknown = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Unknown),
        )(yield* readSource("generated/openapi.json"));
        if (
          typeof packageJsonUnknown !== "object" ||
          packageJsonUnknown === null ||
          typeof openApiDocumentUnknown !== "object" ||
          openApiDocumentUnknown === null
        ) {
          throw new Error("Expected package and OpenAPI JSON objects");
        }
        const packageJson = packageJsonUnknown as {
          readonly exports: Record<string, string | Record<string, string>>;
        };
        const openApiDocument = openApiDocumentUnknown as { readonly openapi: string };

        expect(packageJson.exports["."]).toEqual({
          bun: "./src/bun.ts",
          default: "./src/node.ts",
        });
        expect(packageJson.exports["./effect"]).toBe("./src/effect.ts");
        expect(packageJson.exports["./openapi.json"]).toBe("./src/generated/openapi.json");
        expect(packageJson.exports["./bun"]).toBeUndefined();
        expect(packageJson.exports["./node"]).toBeUndefined();
        expect(openApiDocument.openapi).toBe("3.0.0");
      }),
    ));

  test("exports a stable raw OpenAPI operation id map", () => {
    expect(Object.keys(effectModule.openApiOperationIdMap)).toHaveLength(
      Object.keys(effectModule.operationDefinitions).length,
    );
    expect(effectModule.openApiOperationIdMap["v1-authorize-user"]).toBe("v1AuthorizeUser");
    expect(effectModule.openApiOperationIdMap["v1-diff-a-branch"]).toBe("v1DiffABranch");
    expect(effectModule.openApiOperationIdMap["v1-list-jit-access"]).toBe("v1ListJitAccess");
  });
});
