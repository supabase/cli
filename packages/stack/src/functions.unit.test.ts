import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveConfig } from "./createStack.ts";
import {
  configureFunctionsRuntime,
  functionsRuntimeConfigPath,
  resolveFunctionsRuntimeConfig,
} from "./functions.ts";

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "supabase-stack-functions-"));
}

async function writeProject(cwd: string) {
  await mkdir(join(cwd, "supabase", "functions", "hello-world"), { recursive: true });
  await mkdir(join(cwd, "supabase", "functions", "disabled-function"), { recursive: true });
  await writeFile(
    join(cwd, "supabase", "functions", "hello-world", "index.ts"),
    "Deno.serve(() => Response.json({ ok: true }));\n",
  );
  await writeFile(
    join(cwd, "supabase", "functions", "disabled-function", "index.ts"),
    "Deno.serve(() => Response.json({ disabled: true }));\n",
  );
  await writeFile(
    join(cwd, "supabase", ".env"),
    "CONFIG_ONLY=from-project-env\nSHARED=from-project-env\n",
  );
  await writeFile(
    join(cwd, "supabase", "functions", ".env"),
    "FILE_ONLY=from-functions-env\nSHARED=from-functions-env\n",
  );
  await writeFile(
    join(cwd, "supabase", "config.json"),
    JSON.stringify({
      functions: {
        "hello-world": {
          verify_jwt: true,
          env: {
            CONFIG_ONLY: "env(CONFIG_ONLY)",
            SHARED: "env(SHARED)",
          },
        },
        "disabled-function": {
          enabled: false,
        },
      },
    }),
  );
}

describe("stack Functions runtime config", () => {
  it.live("auto-detects enabled functions from projectDir", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProject(cwd));
      const stackConfig = yield* Effect.promise(() => resolveConfig({ projectDir: cwd }));
      const config = yield* resolveFunctionsRuntimeConfig(stackConfig, {
        hostname: "127.0.0.1",
      });

      expect(config).toBeDefined();
      expect(Object.keys(config!.functions)).toEqual(["hello-world"]);
      expect(config!.functions["hello-world"]).toEqual({
        verifyJWT: true,
        entrypointPath: join(cwd, "supabase", "functions", "hello-world", "index.ts"),
        importMapPath: "",
        staticFiles: [],
      });
      expect(config!.env).toMatchObject({
        FILE_ONLY: "from-functions-env",
        CONFIG_ONLY: "from-project-env",
        SHARED: "from-project-env",
      });
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.promise(() => rm(cwd, { recursive: true, force: true }))),
    );
  });

  it.live("supports explicit env files and disabling JWT verification", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProject(cwd));
      yield* Effect.promise(() => writeFile(join(cwd, "custom.env"), "FILE_ONLY=custom\n"));
      const stackConfig = yield* Effect.promise(() =>
        resolveConfig({
          projectDir: cwd,
          functions: {
            envFile: "custom.env",
            noVerifyJwt: true,
          },
        }),
      );
      const config = yield* resolveFunctionsRuntimeConfig(stackConfig, {
        hostname: "127.0.0.1",
      });

      expect(config!.env.FILE_ONLY).toBe("custom");
      expect(config!.functions["hello-world"]?.verifyJWT).toBe(false);
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.promise(() => rm(cwd, { recursive: true, force: true }))),
    );
  });

  it.live("keeps placeholder mode when Functions are disabled", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProject(cwd));
      const stackConfig = yield* Effect.promise(() =>
        resolveConfig({ projectDir: cwd, functions: false }),
      );
      const config = yield* resolveFunctionsRuntimeConfig(stackConfig, {
        hostname: "127.0.0.1",
      });

      expect(config).toBeUndefined();
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.promise(() => rm(cwd, { recursive: true, force: true }))),
    );
  });

  it.live("writes generated runtime config into the stack runtime directory", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProject(cwd));
      const stackConfig = yield* Effect.promise(() => resolveConfig({ projectDir: cwd }));
      yield* configureFunctionsRuntime(stackConfig, { hostname: "127.0.0.1" });
      const written = JSON.parse(
        yield* Effect.promise(() =>
          readFile(functionsRuntimeConfigPath(stackConfig.runtimeRoot), "utf8"),
        ),
      ) as { functions: Record<string, unknown> };

      expect(Object.keys(written.functions)).toEqual(["hello-world"]);
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.promise(() => rm(cwd, { recursive: true, force: true }))),
    );
  });
});
