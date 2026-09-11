import { describe, expect, it } from "@effect/vitest";
import {
  stackShadowBaselineTarFileName,
  stackShadowCacheKey,
  isStackShadowBaselinePartial,
} from "./stack-shadow.ts";

const base = {
  artifactIdentity: "native:17.6.1",
  majorVersion: 17,
  runtimeKind: "native",
  jwtSecret: "jwt",
  jwtExpiry: 3600,
  dbPassword: "postgres",
  dbSettings: {},
  rolesSql: "",
  bootstrapIdentity: "bootstrap-v1",
};

describe("stackShadowCacheKey", () => {
  it("changes when the artifact identity or runtime kind changes", () => {
    const native = stackShadowCacheKey(base);
    const otherArtifact = stackShadowCacheKey({
      ...base,
      artifactIdentity: "native:17.6.2",
    });
    const container = stackShadowCacheKey({
      ...base,
      artifactIdentity: "container:docker:example",
      runtimeKind: "container:docker",
    });
    expect(native).toMatch(/^[0-9a-f]{16}$/u);
    expect(native).not.toBe(otherArtifact);
    expect(native).not.toBe(container);
    expect(stackShadowBaselineTarFileName(native)).toBe(`stack-shadow-baseline-${native}.tar`);
    expect(stackShadowBaselineTarFileName(native)).not.toContain("shadow-baseline-shadow");
  });

  it("recognizes only this module's own partial temp files as abandoned-sweep candidates", () => {
    const key = "0123456789abcdef";
    expect(isStackShadowBaselinePartial(`stack-shadow-baseline-${key}.tar.4242.partial`)).toBe(
      true,
    );
    for (const other of [
      stackShadowBaselineTarFileName(key),
      `shadow-baseline-${key}.tar.4242.partial`,
      `stack-shadow-baseline-${key}.tar.partial`,
      `stack-shadow-baseline-${key}.tar.4242.partial.bak`,
      "catalog-local-migrations-abc-123.json",
    ]) {
      expect(isStackShadowBaselinePartial(other), other).toBe(false);
    }
  });

  it("changes when roles.sql, db settings, or bootstrap identity change", () => {
    const withRoles = stackShadowCacheKey({ ...base, rolesSql: "create role x;" });
    expect(stackShadowCacheKey(base)).not.toBe(withRoles);
    expect(stackShadowCacheKey({ ...base, dbSettings: { max_connections: 20 } })).not.toBe(
      stackShadowCacheKey(base),
    );
    expect(stackShadowCacheKey({ ...base, bootstrapIdentity: "bootstrap-v2" })).not.toBe(
      stackShadowCacheKey(base),
    );
  });
});
