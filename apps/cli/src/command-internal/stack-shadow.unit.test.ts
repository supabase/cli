import { describe, expect, it } from "@effect/vitest";
import {
  stackShadowBaselineTarFileName,
  stackShadowCacheKey,
  isStackShadowBaselinePartial,
} from "./stack-shadow.ts";

const base = {
  artifactIdentity: "native:17.6.1",
  runtimeIdentity: "native:database:17.6.1",
  bootstrapRecipeId: "database-bootstrap-v1",
  bootstrapInputsId: "inputs:shadow",
  initializationProfileId: "profile:shadow",
  initialization: { profileId: "profile:shadow", recipes: [] },
  rolesSql: "",
  webhooksEnabled: false,
  apiGrantsKept: true,
  vault: [] as const,
  jwks: "",
  storageTargetMigration: "",
};

describe("stackShadowCacheKey", () => {
  it("changes when authoritative runtime or artifact metadata changes", () => {
    const native = stackShadowCacheKey(base);
    expect(native).toMatch(/^[0-9a-f]{16}$/u);
    expect(stackShadowCacheKey({ ...base, artifactIdentity: "native:17.6.2" })).not.toBe(native);
    expect(
      stackShadowCacheKey({ ...base, runtimeIdentity: "container:docker:database:17.6.1" }),
    ).not.toBe(native);
    expect(stackShadowBaselineTarFileName(native)).toBe(`stack-shadow-baseline-${native}.tar`);
  });

  it("includes resolved bootstrap and initialization identities", () => {
    const baseKey = stackShadowCacheKey(base);
    expect(stackShadowCacheKey({ ...base, bootstrapRecipeId: "database-bootstrap-v2" })).not.toBe(
      baseKey,
    );
    expect(stackShadowCacheKey({ ...base, bootstrapInputsId: "inputs:changed" })).not.toBe(baseKey);
    expect(stackShadowCacheKey({ ...base, initializationProfileId: "profile:changed" })).not.toBe(
      baseKey,
    );
    expect(
      stackShadowCacheKey({
        ...base,
        initialization: {
          profileId: "profile:shadow",
          recipes: [{ service: "auth", recipeId: "auth", artifactIdentity: "auth" }],
        },
      }),
    ).not.toBe(baseKey);
  });

  it("changes for CLI overlay inputs", () => {
    const baseKey = stackShadowCacheKey(base);
    expect(stackShadowCacheKey({ ...base, rolesSql: "create role x;" })).not.toBe(baseKey);
    expect(stackShadowCacheKey({ ...base, webhooksEnabled: true })).not.toBe(baseKey);
    expect(stackShadowCacheKey({ ...base, apiGrantsKept: false })).not.toBe(baseKey);
    expect(
      stackShadowCacheKey({ ...base, vault: [{ name: "a", value: "secret", resolved: true }] }),
    ).not.toBe(baseKey);
    expect(stackShadowCacheKey({ ...base, jwks: '{"keys":[]}' })).not.toBe(baseKey);
    expect(stackShadowCacheKey({ ...base, storageTargetMigration: "20240101000000" })).not.toBe(
      baseKey,
    );
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
});
