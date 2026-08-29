import { describe, expect, it } from "vitest";
import { toStartStackConfig, withServiceVersions } from "./stack-config.ts";

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
});

describe("withServiceVersions", () => {
  it("preserves capability configuration while catalog versions are stack-owned", () => {
    const config = toStartStackConfig(undefined, [], "docker");
    expect(withServiceVersions(config, { postgres: "17.6.1" })).toEqual(config);
  });
});
