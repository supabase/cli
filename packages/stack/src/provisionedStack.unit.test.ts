import { describe, expect, it } from "vitest";
import { provisionedStackConfig } from "./provisionedStack.ts";

const baseOptions = {
  dataDir: "/pods/a/data",
  postgresPassword: "secret",
  versions: { postgres: "17.6.1.143" },
} as const;

describe("provisionedStackConfig", () => {
  it("owns the complete postgres-only micro runtime configuration", () => {
    expect(provisionedStackConfig(baseOptions)).toEqual({
      mode: "native",
      stackRoot: undefined,
      lazyServices: undefined,
      postgres: {
        dataDir: "/pods/a/data",
        version: "17.6.1.143",
        password: "secret",
        provisioned: true,
        profile: "micro",
      },
      postgrest: false,
      auth: false,
      edgeRuntime: false,
      realtime: false,
      storage: false,
      imgproxy: false,
      mailpit: false,
      pgmeta: false,
      studio: false,
      analytics: false,
      vector: false,
      pooler: false,
      functions: false,
    });
  });

  it("maps enabled service versions and runtime policy", () => {
    const config = provisionedStackConfig({
      ...baseOptions,
      stackRoot: "/pods/a/stack",
      lazyServices: true,
      enabledServices: ["postgrest", "auth"],
      versions: {
        postgres: "17.6.1.143",
        postgrest: "14.14",
        auth: "2.192.0",
      },
    });

    expect(config.stackRoot).toBe("/pods/a/stack");
    expect(config.lazyServices).toBe(true);
    expect(config.postgrest).toEqual({ version: "14.14" });
    expect(config.auth).toEqual({ version: "2.192.0" });
  });

  it("rejects an enabled service without a pinned version", () => {
    expect(() =>
      provisionedStackConfig({ ...baseOptions, enabledServices: ["postgrest"] }),
    ).toThrow("versions.postgrest is required");
  });

  it("rejects incomplete service dependency sets", () => {
    expect(() =>
      provisionedStackConfig({
        ...baseOptions,
        enabledServices: ["studio"],
        versions: { postgres: "17.6.1.143", studio: "2026.07.07" },
      }),
    ).toThrow("studio requires pgmeta");
  });
});
