import { describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Schema, type Scope } from "effect";
import { CliConfigSchema } from "./base.ts";
import { inferFunctionsManifest } from "./functions-manifest.ts";

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function makeTempProject() {
  return FileSystem.FileSystem.use((fs) =>
    fs.makeTempDirectoryScoped({ prefix: "supabase-functions-manifest-" }),
  );
}

function runConfigEffect<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));
}

describe("functions manifest", () => {
  test("detects default functions from the filesystem", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        const functionDir = join(cwd, "supabase", "functions", "hello-world");
        yield* fs.makeDirectory(functionDir, { recursive: true });
        yield* fs.writeFileString(
          join(functionDir, "index.ts"),
          "Deno.serve(() => new Response())\n",
        );
        yield* fs.writeFileString(join(functionDir, "deno.json"), '{"imports":{}}\n');

        expect(yield* inferFunctionsManifest({ cwd })).toEqual({
          "hello-world": {
            enabled: true,
            verify_jwt: true,
            import_map: "./functions/hello-world/deno.json",
            entrypoint: "./functions/hello-world/index.ts",
            static_files: [],
            env: {},
          },
        });
      }),
    ));

  test("keeps the default import map when config only customizes other fields", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        const functionDir = join(cwd, "supabase", "functions", "hello-world");
        yield* fs.makeDirectory(functionDir, { recursive: true });
        yield* fs.writeFileString(
          join(functionDir, "index.ts"),
          "Deno.serve(() => new Response())\n",
        );
        yield* fs.writeFileString(join(functionDir, "deno.json"), '{"imports":{}}\n');
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.json"),
          yield* encodeJson({
            functions: {
              "hello-world": {
                verify_jwt: false,
              },
            },
          }),
        );

        expect(yield* inferFunctionsManifest({ cwd })).toEqual({
          "hello-world": {
            enabled: true,
            verify_jwt: false,
            import_map: "./functions/hello-world/deno.json",
            entrypoint: "./functions/hello-world/index.ts",
            static_files: [],
            env: {},
          },
        });
      }),
    ));

  test("applies config-only custom functions", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* makeTempProject();
        const config = decodeCliConfig({
          functions: {
            "custom-entrypoint": {
              entrypoint: "./functions/custom-entrypoint/main.ts",
              import_map: "./functions/custom-entrypoint/deno.json",
              static_files: ["./functions/custom-entrypoint/*.html"],
              env: {
                OPENAI_API_KEY: "env(OPENAI_API_KEY)",
              },
            },
          },
        });

        expect(yield* inferFunctionsManifest({ cwd, config })).toEqual({
          "custom-entrypoint": {
            enabled: true,
            verify_jwt: true,
            import_map: "./functions/custom-entrypoint/deno.json",
            entrypoint: "./functions/custom-entrypoint/main.ts",
            static_files: ["./functions/custom-entrypoint/*.html"],
            env: {
              OPENAI_API_KEY: "env(OPENAI_API_KEY)",
            },
          },
        });
      }),
    ));

  test("uses slug defaults for config-only functions with non-path overrides", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* makeTempProject();
        const config = decodeCliConfig({
          functions: {
            "hello-world": {
              verify_jwt: false,
            },
          },
        });

        expect(yield* inferFunctionsManifest({ cwd, config })).toEqual({
          "hello-world": {
            enabled: true,
            verify_jwt: false,
            import_map: "",
            entrypoint: "./functions/hello-world/index.ts",
            static_files: [],
            env: {},
          },
        });
      }),
    ));

  test("keeps disabled filesystem functions in the inferred manifest", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const config = decodeCliConfig({
          functions: {
            "hello-world": {
              enabled: false,
            },
          },
        });

        const functionDir = join(cwd, "supabase", "functions", "hello-world");
        yield* fs.makeDirectory(functionDir, { recursive: true });
        yield* fs.writeFileString(
          join(functionDir, "index.ts"),
          "Deno.serve(() => new Response())\n",
        );

        expect(yield* inferFunctionsManifest({ cwd, config })).toEqual({
          "hello-world": {
            enabled: false,
            verify_jwt: true,
            import_map: "",
            entrypoint: "./functions/hello-world/index.ts",
            static_files: [],
            env: {},
          },
        });
      }),
    ));

  test("ignores directories that are not default function shapes", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase", "functions", "missing-entrypoint"), {
          recursive: true,
        });
        yield* fs.makeDirectory(join(cwd, "supabase", "functions", "invalid.slug"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          join(cwd, "supabase", "functions", "invalid.slug", "index.ts"),
          "Deno.serve(() => new Response())\n",
        );

        expect(yield* inferFunctionsManifest({ cwd })).toEqual({});
      }),
    ));

  test("search: false does not climb to an ancestor project's functions", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const projectRoot = yield* makeTempProject();
        const nestedCwd = join(projectRoot, "nested", "workdir");

        const functionDir = join(projectRoot, "supabase", "functions", "hello-world");
        yield* fs.makeDirectory(functionDir, { recursive: true });
        yield* fs.writeFileString(
          join(functionDir, "index.ts"),
          "Deno.serve(() => new Response())\n",
        );
        yield* fs.writeFileString(join(projectRoot, "supabase", "config.json"), "{}\n");
        yield* fs.makeDirectory(nestedCwd, { recursive: true });

        expect(yield* inferFunctionsManifest({ cwd: nestedCwd })).toEqual({
          "hello-world": {
            enabled: true,
            verify_jwt: true,
            import_map: "",
            entrypoint: "./functions/hello-world/index.ts",
            static_files: [],
            env: {},
          },
        });

        expect(yield* inferFunctionsManifest({ cwd: nestedCwd, search: false })).toEqual({});
      }),
    ));
});
