// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { join } from "node:path";
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
        edge_runtime: { secrets: { SHARED: Redacted.make("automatic") } },
        functions: {
          hello: {
            verify_jwt: true,
            import_map: "deno.json",
            env: { LOCAL: Redacted.make("function") },
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
      const projectRoot = mkdtempSync(join(tmpdir(), "supabase-stack-functions-config-"));
      mkdirSync(join(projectRoot, "supabase", "functions", "hello"), { recursive: true });
      writeFileSync(join(projectRoot, "serve.env"), "SHARED=explicit\nMULTILINE=one\\ntwo\n");
      writeFileSync(join(projectRoot, "supabase", "functions", "import_map.json"), "{}\n");
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(projectRoot, { recursive: true })));

      const config = yield* functionsServeStackConfig({
        config: baseConfig,
        flags: flags({
          noVerifyJwt: Option.some(true),
          envFile: Option.some("serve.env"),
          importMap: Option.some("supabase/functions/import_map.json"),
          inspect: true,
          inspectMain: true,
        }),
        projectRoot,
        cwd: projectRoot,
        debug: true,
      });
      const capability = config.capabilities?.functions;
      if (capability?.enabled === false) return yield* Effect.die("Functions were disabled");
      const settings = capability?.settings;
      expect(settings?.debug).toBe(true);
      expect(settings?.inspector).toEqual({ mode: "brk", main: true });
      expect(settings?.edge_runtime?.verify_jwt_default).toBe(false);
      expect(settings?.edge_runtime?.import_map_default).toBe("import_map.json");
      const shared = settings?.edge_runtime?.secrets?.SHARED;
      if (shared === undefined) return yield* Effect.die("Explicit environment was not applied");
      expect(Redacted.value(shared)).toBe("explicit");
      expect(settings?.functions?.hello?.verify_jwt).toBe(false);
      expect(settings?.functions?.hello?.import_map).toBe("../import_map.json");
      expect(settings?.functions?.hello?.env).toEqual({});
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
