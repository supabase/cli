import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { ProjectConfigSchema } from "./base.ts";
import { inferFunctionsManifest } from "./functions-manifest.ts";
import { loadProjectEnvironment } from "./project.ts";

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

const withTempProject = <A, E>(
  run: (cwd: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Effect.Effect<A, E | PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-functions-manifest-" });
      return yield* run(cwd);
    }),
  );

class FunctionsManifestTestError extends Data.TaggedError("FunctionsManifestTestError")<{
  readonly cause: unknown;
}> {}

const platform = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  effect.pipe(
    Effect.provide(BunServices.layer),
    Effect.mapError((cause) => new FunctionsManifestTestError({ cause })),
  );

describe("functions manifest", () => {
  it.effect("detects default functions from the filesystem", () =>
    platform(
      withTempProject((cwd) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const functionDir = path.join(cwd, "supabase", "functions", "hello-world");
          yield* fs.makeDirectory(functionDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(functionDir, "index.ts"),
            "Deno.serve(() => new Response())\n",
          );
          yield* fs.writeFileString(path.join(functionDir, "deno.json"), '{"imports":{}}\n');

          const manifest = yield* inferFunctionsManifest({ cwd });
          expect(manifest).toEqual({
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
      ),
    ),
  );

  it.effect("keeps the default import map when config only customizes other fields", () =>
    platform(
      withTempProject((cwd) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const functionDir = path.join(cwd, "supabase", "functions", "hello-world");
          yield* fs.makeDirectory(functionDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(functionDir, "index.ts"),
            "Deno.serve(() => new Response())\n",
          );
          yield* fs.writeFileString(path.join(functionDir, "deno.json"), '{"imports":{}}\n');
          yield* fs.writeFileString(
            path.join(cwd, "supabase", "config.json"),
            '{"functions":{"hello-world":{"verify_jwt":false}}}',
          );

          const manifest = yield* inferFunctionsManifest({ cwd });
          expect(manifest).toEqual({
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
      ),
    ),
  );

  it.effect("resolves function config from an injected project environment", () =>
    platform(
      withTempProject((cwd) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const functionDir = path.join(cwd, "supabase", "functions", "hello-world");
          yield* fs.makeDirectory(functionDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(functionDir, "index.ts"),
            "Deno.serve(() => new Response())\n",
          );
          yield* fs.writeFileString(
            path.join(cwd, "supabase", "config.toml"),
            `[functions.hello-world]\nentrypoint = "env(FUNCTION_ENTRYPOINT)"\n`,
          );
          const projectEnv = yield* loadProjectEnvironment({
            cwd,
            baseEnv: { FUNCTION_ENTRYPOINT: "./functions/hello-world/index.ts" },
          });
          if (projectEnv === null) {
            return yield* Effect.die("expected a project environment");
          }

          const manifest = yield* inferFunctionsManifest({ cwd, projectEnv });

          expect(manifest["hello-world"]?.entrypoint).toBe("./functions/hello-world/index.ts");
        }),
      ),
    ),
  );

  it.effect("applies config-only custom functions", () =>
    platform(
      withTempProject((cwd) => {
        const config = decodeProjectConfig({
          functions: {
            "custom-entrypoint": {
              entrypoint: "./functions/custom-entrypoint/main.ts",
              import_map: "./functions/custom-entrypoint/deno.json",
              static_files: ["./functions/custom-entrypoint/*.html"],
              env: { OPENAI_API_KEY: "env(OPENAI_API_KEY)" },
            },
          },
        });
        return Effect.gen(function* () {
          const manifest = yield* inferFunctionsManifest({ cwd, config });
          expect(manifest).toEqual({
            "custom-entrypoint": {
              enabled: true,
              verify_jwt: true,
              import_map: "./functions/custom-entrypoint/deno.json",
              entrypoint: "./functions/custom-entrypoint/main.ts",
              static_files: ["./functions/custom-entrypoint/*.html"],
              env: { OPENAI_API_KEY: "env(OPENAI_API_KEY)" },
            },
          });
        });
      }),
    ),
  );

  it.effect("uses slug defaults for config-only functions with non-path overrides", () =>
    platform(
      withTempProject((cwd) => {
        const config = decodeProjectConfig({ functions: { "hello-world": { verify_jwt: false } } });
        return Effect.gen(function* () {
          const manifest = yield* inferFunctionsManifest({ cwd, config });
          expect(manifest).toEqual({
            "hello-world": {
              enabled: true,
              verify_jwt: false,
              import_map: "",
              entrypoint: "./functions/hello-world/index.ts",
              static_files: [],
              env: {},
            },
          });
        });
      }),
    ),
  );

  it.effect("keeps disabled filesystem functions in the inferred manifest", () =>
    platform(
      withTempProject((cwd) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const functionDir = path.join(cwd, "supabase", "functions", "hello-world");
          yield* fs.makeDirectory(functionDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(functionDir, "index.ts"),
            "Deno.serve(() => new Response())\n",
          );
          const config = decodeProjectConfig({ functions: { "hello-world": { enabled: false } } });
          const manifest = yield* inferFunctionsManifest({ cwd, config });
          expect(manifest).toEqual({
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
      ),
    ),
  );

  it.effect("ignores directories that are not default function shapes", () =>
    platform(
      withTempProject((cwd) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.makeDirectory(path.join(cwd, "supabase", "functions", "missing-entrypoint"), {
            recursive: true,
          });
          const invalid = path.join(cwd, "supabase", "functions", "invalid.slug");
          yield* fs.makeDirectory(invalid, { recursive: true });
          yield* fs.writeFileString(
            path.join(invalid, "index.ts"),
            "Deno.serve(() => new Response())\n",
          );
          expect(yield* inferFunctionsManifest({ cwd })).toEqual({});
        }),
      ),
    ),
  );

  it.effect("search: false does not climb to an ancestor project's functions", () =>
    platform(
      withTempProject((projectRoot) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const functionDir = path.join(projectRoot, "supabase", "functions", "hello-world");
          const nestedCwd = path.join(projectRoot, "nested", "workdir");
          yield* fs.makeDirectory(functionDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(functionDir, "index.ts"),
            "Deno.serve(() => new Response())\n",
          );
          yield* fs.writeFileString(path.join(projectRoot, "supabase", "config.json"), "{}\n");
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
      ),
    ),
  );
});
