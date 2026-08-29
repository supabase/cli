import { describe, expect, it } from "vitest";
import { CliConfigSchema } from "@supabase/config";
import { Schema } from "effect";
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
    const loaded = Schema.decodeUnknownSync(CliConfigSchema)({
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
});
