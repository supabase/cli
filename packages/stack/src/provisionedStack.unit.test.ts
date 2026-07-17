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
      mode: "auto",
      stackRoot: undefined,
      startServices: undefined,
      projectDir: undefined,
      jwtSecret: undefined,
      publishableKey: undefined,
      secretKey: undefined,
      services: undefined,
      postgres: {
        dataDir: "/pods/a/data",
        version: "17.6.1.143",
        password: "secret",
        provisioned: true,
        profile: "micro",
      },
      postgrest: undefined,
      auth: undefined,
      edgeRuntime: undefined,
      realtime: undefined,
      storage: undefined,
      imgproxy: undefined,
      mailpit: undefined,
      pgmeta: undefined,
      studio: undefined,
      analytics: undefined,
      vector: undefined,
      pooler: undefined,
      functions: false,
    });
  });

  it("maps enabled service versions and runtime policy", () => {
    const config = provisionedStackConfig({
      ...baseOptions,
      stackRoot: "/pods/a/stack",
      startServices: ["postgrest", "auth"],
      services: ["postgrest", "auth"],
      versions: {
        postgres: "17.6.1.143",
        postgrest: "14.14",
        auth: "2.192.0",
      },
    });

    expect(config.stackRoot).toBe("/pods/a/stack");
    expect(config.startServices).toEqual(["postgrest", "auth"]);
    expect(config.postgrest).toEqual({ version: "14.14" });
    expect(config.auth).toEqual({ version: "2.192.0" });
  });

  it("rejects an enabled service without a pinned version", () => {
    expect(() => provisionedStackConfig({ ...baseOptions, services: ["postgrest"] })).toThrow(
      "versions.postgrest is required",
    );
  });

  it("rejects incomplete service dependency sets", () => {
    expect(() =>
      provisionedStackConfig({
        ...baseOptions,
        services: ["studio"],
        versions: { postgres: "17.6.1.143", studio: "2026.07.07" },
      }),
    ).toThrow("studio requires pgmeta");
  });
});
