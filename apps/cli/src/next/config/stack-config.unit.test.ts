import { describe, expect, it } from "vitest";
import { CliConfigSchema } from "@supabase/config";
import { Redacted, Schema } from "effect";
import { StackConfigSchema } from "@supabase/stack/effect";
import { toStartStackConfig } from "./stack-config.ts";

describe("toStartStackConfig", () => {
  it("leaves runtime selection to the stack when mode is unset", () => {
    expect(toStartStackConfig(undefined, [], undefined)).toMatchObject({
      capabilities: expect.any(Object),
    });
  });

  it("keeps configured capabilities enabled for native mode", () => {
    const config = toStartStackConfig(undefined, [], "native");
    expect(config.capabilities?.database).toMatchObject({ settings: expect.any(Object) });
    expect(config.capabilities?.rest).toEqual({ settings: expect.any(Object) });
    expect(config.capabilities?.functions).toEqual({ settings: expect.any(Object) });
  });

  it("disables explicitly excluded capabilities in container mode", () => {
    const config = toStartStackConfig(undefined, ["auth", "storage"], "docker");
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
    const config = toStartStackConfig(loaded, [], "native");
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

    const decoded = Schema.decodeSync(StackConfigSchema)(toStartStackConfig(loaded, [], "native"));

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
});
