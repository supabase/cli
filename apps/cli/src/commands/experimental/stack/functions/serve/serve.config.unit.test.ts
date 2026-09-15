// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { join, relative } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Redacted } from "effect";
import type { StackConfig } from "@supabase/stack/effect";
import { functionsServeStackConfig } from "./serve.config.ts";
import { StackFunctionsServeError } from "./serve.errors.ts";

const baseConfig: StackConfig = {
  capabilities: {
    functions: {
      settings: {
        edge_runtime: {
          secrets: {
            CONFIG_ONLY: Redacted.make("config"),
            SHARED: Redacted.make("config"),
            SUPABASE_CONFIG: Redacted.make("reserved-config"),
          },
        },
        functions: {
          hello: {
            verify_jwt: true,
            import_map: "deno.json",
            env: {
              LOCAL: Redacted.make("function"),
              SHARED: Redacted.make("function"),
            },
          },
        },
      },
    },
  },
};

const flags = (overrides: Partial<Parameters<typeof functionsServeStackConfig>[0]["flags"]> = {}) =>
  ({
    noVerifyJwt: Option.none<boolean>(),
    envFile: Option.none<string>(),
    importMap: Option.none<string>(),
    inspect: false,
    inspectMode: Option.none(),
    inspectMain: false,
    all: true,
    ...overrides,
  }) satisfies Parameters<typeof functionsServeStackConfig>[0]["flags"];

describe("managed stack Functions serve config", () => {
  it.live("applies invocation overrides with legacy path and precedence rules", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "supabase-stack-functions-config-"));
      const projectRoot = join(root, "project");
      const cwd = join(root, "caller");
      mkdirSync(join(projectRoot, "supabase", "functions", "hello"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
        join(cwd, "serve.env"),
        "SHARED=explicit\nMULTILINE=one\\ntwo\nSUPABASE_EXPLICIT=reserved\n",
      );
      const importMapPath = join(cwd, "import_map.json");
      writeFileSync(importMapPath, "{}\n");
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true })));

      const result = yield* functionsServeStackConfig({
        config: baseConfig,
        flags: flags({
          noVerifyJwt: Option.some(true),
          envFile: Option.some("serve.env"),
          importMap: Option.some("import_map.json"),
          inspect: true,
          inspectMain: true,
        }),
        projectRoot,
        cwd,
        debug: true,
      });
      const config = result.config;
      const capability = config.capabilities?.functions;
      if (capability?.enabled === false) return yield* Effect.die("Functions were disabled");
      const settings = capability?.settings;
      expect(settings?.debug).toBe(true);
      expect(settings?.inspector).toEqual({ mode: "brk", main: true });
      expect(settings?.edge_runtime?.verify_jwt_default).toBe(false);
      expect(settings?.edge_runtime?.import_map_default).toBe(importMapPath);
      expect(result.importMapSource).toBe(importMapPath);
      expect(result.watchPaths).toEqual([importMapPath, join(cwd, "serve.env")]);
      expect(result.warnings).toEqual([
        "Env name cannot start with SUPABASE_, skipping: SUPABASE_CONFIG\n",
        "Env name cannot start with SUPABASE_, skipping: SUPABASE_EXPLICIT\n",
      ]);
      const configOnly = settings?.edge_runtime?.secrets?.CONFIG_ONLY;
      const shared = settings?.edge_runtime?.secrets?.SHARED;
      if (configOnly === undefined || shared === undefined)
        return yield* Effect.die("Explicit environment was not applied");
      expect(Redacted.value(configOnly)).toBe("config");
      expect(Redacted.value(shared)).toBe("explicit");
      expect(settings?.edge_runtime?.secrets?.SUPABASE_CONFIG).toBeUndefined();
      expect(settings?.edge_runtime?.secrets?.SUPABASE_EXPLICIT).toBeUndefined();
      expect(settings?.functions?.hello?.verify_jwt).toBe(false);
      expect(settings?.functions?.hello?.import_map).toBe(
        relative(join(projectRoot, "supabase", "functions", "hello"), importMapPath).replaceAll(
          "\\",
          "/",
        ),
      );
      const local = settings?.functions?.hello?.env?.LOCAL;
      const functionShared = settings?.functions?.hello?.env?.SHARED;
      if (local === undefined || functionShared === undefined)
        return yield* Effect.die("Config-defined function environment was not preserved");
      expect(Redacted.value(local)).toBe("function");
      expect(Redacted.value(functionShared)).toBe("function");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("rejects invalid inspector combinations before contacting the stack", () =>
    Effect.gen(function* () {
      const failure = yield* functionsServeStackConfig({
        config: baseConfig,
        flags: flags({ inspect: true, inspectMode: Option.some("wait") }),
        projectRoot: "/project",
        cwd: "/project",
        debug: false,
      }).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(StackFunctionsServeError);
      expect(failure.reason).toBe("flags");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("filters reserved config secrets without an explicit env file", () =>
    Effect.gen(function* () {
      const result = yield* functionsServeStackConfig({
        config: baseConfig,
        flags: flags(),
        projectRoot: "/project",
        cwd: "/project",
        debug: false,
      });
      const functions = result.config.capabilities?.functions;
      const settings = functions !== undefined && "settings" in functions ? functions.settings : {};

      expect(settings?.edge_runtime?.secrets?.SUPABASE_CONFIG).toBeUndefined();
      expect(result.warnings).toEqual([
        "Env name cannot start with SUPABASE_, skipping: SUPABASE_CONFIG\n",
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects a project with Edge Functions disabled", () =>
    Effect.gen(function* () {
      const failure = yield* functionsServeStackConfig({
        config: { capabilities: { functions: { enabled: false } } },
        flags: flags(),
        projectRoot: "/project",
        cwd: "/project",
        debug: false,
      }).pipe(Effect.flip);
      expect(failure.message).toContain("disabled");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
