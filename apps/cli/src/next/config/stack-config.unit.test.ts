import { describe, expect, it } from "vitest";
import { CliConfigSchema } from "@supabase/config";
import { Effect, Redacted, Schema } from "effect";
import { StackConfigSchema } from "@supabase/stack/effect";
import {
  isFunctionScopedPath,
  relativeFunctionPath,
  relativeGlobalFunctionPath,
  type CliConfigWithRawPresence,
  toStartStackConfig,
} from "./stack-config.ts";

describe("toStartStackConfig", () => {
  const loadedConfig = (
    document: Record<string, unknown>,
    configInput: Record<string, unknown> = document,
  ): CliConfigWithRawPresence => ({
    config: Schema.decodeSync(CliConfigSchema)(configInput),
    document,
  });

  it("leaves runtime selection to the stack", () => {
    expect(Effect.runSync(toStartStackConfig(undefined, []))).toMatchObject({
      capabilities: expect.any(Object),
    });
  });

  it("keeps configured capabilities enabled by default", () => {
    const config = Effect.runSync(toStartStackConfig(undefined, []));
    expect(config.capabilities?.database).toMatchObject({ settings: expect.any(Object) });
    expect(config.capabilities?.rest).toEqual({ settings: expect.any(Object) });
    expect(config.capabilities?.functions).toEqual({ settings: expect.any(Object) });
  });

  it("disables explicitly excluded capabilities", () => {
    const config = Effect.runSync(toStartStackConfig(undefined, ["auth", "storage"]));
    expect(config.capabilities?.auth).toEqual({ enabled: false });
    expect(config.capabilities?.storage).toEqual({ enabled: false });
    expect(config.capabilities?.rest).toMatchObject({ settings: expect.any(Object) });
  });

  it("emits project-relative Functions roots and JWKS security from loaded config", () => {
    const loaded = Schema.decodeSync(CliConfigSchema)({
      auth: { signing_keys_path: "supabase/jwks.json" },
      edge_runtime: { secrets: { EDGE_TOKEN: "env(EDGE_TOKEN)" } },
      functions: { hello: { env: { FUNCTION_TOKEN: "env(FUNCTION_TOKEN)" } } },
    });
    const config = Effect.runSync(toStartStackConfig(loaded, []));
    expect(config.capabilities?.functions).toMatchObject({
      settings: { functions_root: "supabase/functions" },
    });
    expect(config.security?.jwt?.signing).toEqual({
      kind: "jwks-file",
      path: "supabase/jwks.json",
    });
  });

  it("translates a decoded CLI config into a schema-valid stack config", () => {
    const loaded = Schema.decodeSync(CliConfigSchema)({
      api: {},
      auth: { jwt_secret: "jwt-secret" },
      db: { settings: { session_replication_role: "origin" } },
      edge_runtime: { secrets: { EDGE_TOKEN: "env(EDGE_TOKEN)" } },
      functions: { hello: { env: { FUNCTION_TOKEN: "env(FUNCTION_TOKEN)" } } },
    });

    const decoded = Schema.decodeSync(StackConfigSchema)(
      Effect.runSync(toStartStackConfig(loaded, [])),
    );

    expect(decoded.capabilities?.database?.version).toBe("17");
    expect(decoded.capabilities?.database?.settings?.settings?.session_replication_role).toBe(
      "origin",
    );
    expect(decoded.capabilities?.functions).toMatchObject({
      settings: { functions_root: "supabase/functions" },
    });
    expect(decoded.listeners?.api).toMatchObject({ port: 54321 });
    const jwtSecret = decoded.security?.jwt?.signing;
    expect(jwtSecret?.kind).toBe("symmetric");
    if (jwtSecret?.kind === "symmetric") {
      expect(Redacted.isRedacted(jwtSecret.secret)).toBe(true);
      expect(Redacted.value(jwtSecret.secret)).toBe("jwt-secret");
    }
  });

  it("leaves omitted listener ports automatic while preserving explicit defaults", () => {
    const loaded = loadedConfig(
      {
        api: {},
        db: { port: 54322 },
        studio: {},
        local_smtp: {},
        edge_runtime: {},
      },
      {
        api: {},
        db: { port: 54322 },
        studio: {},
        local_smtp: {},
        edge_runtime: {},
      },
    );
    const config = Effect.runSync(toStartStackConfig(loaded, []));

    expect(config.listeners?.api).toBeUndefined();
    expect(config.listeners?.database).toEqual({ port: 54322 });
    expect(config.listeners?.studio).toBeUndefined();
    expect(config.listeners?.mailUi).toBeUndefined();
    expect(config.listeners?.smtp).toBeUndefined();
    expect(config.listeners?.pop3).toBeUndefined();
    expect(config.listeners?.functionsInspector).toBeUndefined();
  });

  it("keeps an explicit default port instead of treating it as omitted", () => {
    const loaded = loadedConfig({ api: { port: 54321 } }, { api: { port: 54321 } });
    const config = Effect.runSync(toStartStackConfig(loaded, []));

    expect(config.listeners?.api).toEqual({ port: 54321 });
  });

  it("disables dedicated listeners when their capabilities are disabled", () => {
    const loaded = loadedConfig(
      {
        db: { pooler: { enabled: false } },
        studio: { enabled: false },
        local_smtp: { enabled: false },
        edge_runtime: { enabled: false },
      },
      {
        db: { pooler: { enabled: false } },
        studio: { enabled: false },
        local_smtp: { enabled: false },
        edge_runtime: { enabled: false },
      },
    );
    const config = Effect.runSync(toStartStackConfig(loaded, []));

    expect(config.listeners?.pooler).toEqual({ enabled: false });
    expect(config.listeners?.studio).toEqual({ enabled: false });
    expect(config.listeners?.mailUi).toEqual({ enabled: false });
    expect(config.listeners?.smtp).toEqual({ enabled: false });
    expect(config.listeners?.pop3).toEqual({ enabled: false });
    expect(config.listeners?.functionsInspector).toEqual({ enabled: false });
  });

  it("disables excluded dedicated listeners without changing API listeners", () => {
    const loaded = loadedConfig(
      { api: { enabled: false, port: 54321 }, db: { port: 54322 }, studio: { port: 54323 } },
      { api: { enabled: false, port: 54321 }, db: { port: 54322 }, studio: { port: 54323 } },
    );
    const config = Effect.runSync(toStartStackConfig(loaded, ["studio", "pooler"]));

    expect(config.capabilities?.rest).toEqual({ enabled: false });
    expect(config.listeners?.api).toEqual({ port: 54321 });
    expect(config.listeners?.database).toEqual({ port: 54322 });
    expect(config.listeners?.studio).toEqual({ enabled: false });
    expect(config.listeners?.pooler).toEqual({ enabled: false });
  });

  it("translates Functions paths from the supabase directory to each function directory", () => {
    const loaded = Schema.decodeSync(CliConfigSchema)({
      functions: {
        hello: {
          entrypoint: "./functions/hello/main.ts",
          import_map: "./functions/hello/deno.json",
          static_files: ["./functions/hello/public/*.html"],
        },
      },
    });
    const config = Effect.runSync(toStartStackConfig(loaded, []));
    const functions = config.capabilities?.functions;
    if (functions === undefined || !("settings" in functions) || functions.settings === undefined)
      throw new Error("Functions settings were not translated");
    expect(functions.settings.functions?.hello).toMatchObject({
      entrypoint: "main.ts",
      import_map: "deno.json",
      static_files: ["public/*.html"],
    });
  });

  it("translates a global Functions path for newly discovered slugs", () => {
    expect(relativeGlobalFunctionPath("./functions/hello/deno.json")).toBe("hello/deno.json");
    expect(relativeGlobalFunctionPath("./functions/deno.json")).toBe("deno.json");
    expect(relativeGlobalFunctionPath("supabase/functions/deno.json")).toBe("deno.json");
    expect(relativeGlobalFunctionPath("deno.json")).toBe("deno.json");
    expect(
      relativeGlobalFunctionPath("/tmp/project/supabase/functions/shared/deno.json", {
        projectRoot: "/tmp/project",
      }),
    ).toBe("shared/deno.json");
    expect(isFunctionScopedPath("hello", "./functions/hello/deno.json")).toBe(true);
    expect(isFunctionScopedPath("created", "./functions/hello/deno.json")).toBe(false);
    expect(relativeFunctionPath("hello", "supabase/functions/hello/deno.json")).toBe("deno.json");
  });
});
