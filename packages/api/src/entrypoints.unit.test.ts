import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path, Schema } from "effect";
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
    expect(typeof createNodeApiClient).toBe("function");
    expect(typeof effectModule.makeApiClient).toBe("function");
    expect(effectModule.ApiConfig).toBeDefined();
    expect(effectModule.apiConfigLayer).toBeDefined();
    expect(effectModule.DEFAULT_SUPABASE_API_URL).toBe("https://api.supabase.com");
  });

  test("does not generate separate promise or standalone operation artifacts", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const srcDir = path.dirname(fileURLToPath(import.meta.url));
        expect(yield* fs.exists(path.join(srcDir, "generated/promise-client.ts"))).toBe(false);
        expect(yield* fs.exists(path.join(srcDir, "generated/effect-operations.ts"))).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  test("ships the OpenAPI spec as a json subpath artifact", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
        const srcDir = path.dirname(fileURLToPath(import.meta.url));
        const packageJson = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ exports: Schema.Record(Schema.String, Schema.Unknown) }),
          ),
        )(decoder.decode(yield* fs.readFile(path.join(srcDir, "../package.json"))));
        const openApiDocument = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ openapi: Schema.Unknown })),
        )(decoder.decode(yield* fs.readFile(path.join(srcDir, "generated/openapi.json"))));

        expect(packageJson.exports["."]).toEqual({
          bun: "./src/bun.ts",
          default: "./src/node.ts",
        });
        expect(packageJson.exports["./effect"]).toBe("./src/effect.ts");
        expect(packageJson.exports["./permissions"]).toBe("./src/generated/permissions.ts");
        expect(packageJson.exports["./openapi.json"]).toBe("./src/generated/openapi.json");
        expect(packageJson.exports["./bun"]).toBeUndefined();
        expect(packageJson.exports["./node"]).toBeUndefined();
        expect(openApiDocument.openapi).toBe("3.0.0");
      }).pipe(Effect.provide(NodeServices.layer)),
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
