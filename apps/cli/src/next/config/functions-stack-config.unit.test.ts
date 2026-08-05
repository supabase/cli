import { BunServices } from "@effect/platform-bun";
import { loadProjectConfig, loadProjectEnvironment } from "@supabase/config";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translateStartFunctionsStackConfig } from "./functions-stack-config.ts";

function makeProject() {
  return mkdtempSync(join(tmpdir(), "supabase-functions-stack-config-"));
}

describe("translateStartFunctionsStackConfig", () => {
  it.live("resolves manifest paths and exact environment precedence before stack handoff", () => {
    const projectRoot = makeProject();

    return Effect.gen(function* () {
      const supabaseDir = join(projectRoot, "supabase");
      yield* Effect.promise(() =>
        Promise.all([
          mkdir(join(supabaseDir, "functions", "auto"), { recursive: true }),
          mkdir(join(supabaseDir, "functions", "hello", "assets"), { recursive: true }),
          mkdir(join(supabaseDir, "functions", "disabled"), { recursive: true }),
        ]),
      );
      yield* Effect.promise(() =>
        Promise.all([
          writeFile(join(supabaseDir, "functions", "auto", "index.ts"), "export {};\n"),
          writeFile(join(supabaseDir, "functions", "auto", "deno.json"), "{}\n"),
          writeFile(join(supabaseDir, "functions", "hello", "main.ts"), "export {};\n"),
          writeFile(join(supabaseDir, "functions", "hello", "deno.json"), "{}\n"),
          writeFile(join(supabaseDir, "functions", "disabled", "index.ts"), "export {};\n"),
          writeFile(
            join(supabaseDir, "functions", ".env"),
            "SHARED=dotenv-shared\nDOT_ONLY=dotenv-only\nSUPABASE_URL=dotenv-url\n",
          ),
          writeFile(
            join(supabaseDir, ".env.local"),
            "EDGE_VALUE=edge-from-reference\nFUNCTION_VALUE=function-from-reference\nFUNCTION_SHARED=function-shared\nFUNCTION_URL=function-url\n",
          ),
          writeFile(
            join(supabaseDir, "config.toml"),
            `[edge_runtime.secrets]
shared = "edge-shared"
edge_only = "env(EDGE_VALUE)"
missing = "env(DOES_NOT_EXIST)"
SUPABASE_URL = "edge-url"

[functions.hello]
verify_jwt = false
entrypoint = "./functions/hello/main.ts"
import_map = "./functions/hello/deno.json"
static_files = ["./functions/hello/assets/*"]

[functions.hello.env]
SHARED = "env(FUNCTION_SHARED)"
FUNCTION_ONLY = "env(FUNCTION_VALUE)"
SUPABASE_URL = "env(FUNCTION_URL)"

[functions.disabled]
enabled = false

[functions.manual]
entrypoint = "./functions/manual.ts"
`,
          ),
        ]),
      );

      const projectEnvironment = yield* loadProjectEnvironment({ cwd: projectRoot, baseEnv: {} });
      const loadedProjectConfig = yield* loadProjectConfig(
        projectRoot,
        projectEnvironment === null ? {} : { projectEnv: projectEnvironment },
      );
      const bundle = yield* translateStartFunctionsStackConfig({
        loadedProjectConfig,
        projectEnvironment,
        projectRoot,
        configDir: supabaseDir,
        envFilePath: join(supabaseDir, "functions", ".env"),
      });

      expect(bundle.env).toEqual({
        SHARED: "dotenv-shared",
        EDGE_ONLY: "edge-from-reference",
        SUPABASE_URL: "dotenv-url",
        DOT_ONLY: "dotenv-only",
      });
      expect(bundle.env).not.toHaveProperty("MISSING");
      expect(bundle.functions.map(({ name }) => name)).toEqual(["auto", "hello", "manual"]);
      expect(bundle.functions[0]).toMatchObject({
        name: "auto",
        verifyJWT: true,
        entrypointPath: join(supabaseDir, "functions", "auto", "index.ts"),
        importMapPath: join(supabaseDir, "functions", "auto", "deno.json"),
      });
      expect(bundle.functions[1]).toEqual({
        name: "hello",
        verifyJWT: false,
        entrypointPath: join(supabaseDir, "functions", "hello", "main.ts"),
        importMapPath: join(supabaseDir, "functions", "hello", "deno.json"),
        staticFiles: [join(supabaseDir, "functions", "hello", "assets", "*")],
        env: {
          SHARED: "function-shared",
          FUNCTION_ONLY: "function-from-reference",
          SUPABASE_URL: "function-url",
        },
      });
      expect(bundle.functions[2]).toMatchObject({
        name: "manual",
        entrypointPath: join(supabaseDir, "functions", "manual.ts"),
        importMapPath: null,
      });
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.promise(() => rm(projectRoot, { recursive: true, force: true }))),
    );
  });

  it.live("reports dotenv failures without retaining resolved secret values", () => {
    const projectRoot = makeProject();

    return Effect.gen(function* () {
      const supabaseDir = join(projectRoot, "supabase");
      yield* Effect.promise(() => mkdir(join(supabaseDir, "functions"), { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(
          join(supabaseDir, "functions", ".env"),
          "VALID_SECRET=private-functions-value\ninvalid private-functions-value\n",
        ),
      );

      const exit = yield* translateStartFunctionsStackConfig({
        loadedProjectConfig: null,
        projectEnvironment: null,
        projectRoot,
        configDir: supabaseDir,
        envFilePath: join(supabaseDir, "functions", ".env"),
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).not.toContain("private-functions-value");
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.promise(() => rm(projectRoot, { recursive: true, force: true }))),
    );
  });
});
