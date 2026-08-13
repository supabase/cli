import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import {
  legacyIsStaleShadowBaselineTar,
  legacyShadowBaselineTarFileName,
  legacyShadowCacheEnabled,
  legacyShadowCacheKey,
  type LegacyShadowCacheKeyInputs,
} from "./shadow-cache.ts";

const baseKeyInputs = (): LegacyShadowCacheKeyInputs => ({
  postgresImage: "public.ecr.aws/supabase/postgres:17.6.1.158",
  majorVersion: 17,
  shadowPort: 54320,
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwtExpiry: 3600,
  rootKey: "d4dc5b6d4a1d6a10b2c1e5b6a7c8d9e0",
  dbPassword: "postgres",
  dbSettings: { effective_cache_size: "128MB", max_connections: 100 },
  autoExposeNewTables: Option.none(),
  storageTargetMigration: "20240101000000",
  rolesSql: "create role custom_role;\n",
  vault: [{ name: "secret", value: "value", resolved: true }],
  jwks: '{"keys":[]}',
  services: {
    realtime: { enabled: true, image: "supabase/realtime:v2.34.47" },
    storage: { enabled: true, image: "supabase/storage-api:v1.25.7" },
    auth: { enabled: true, image: "supabase/gotrue:v2.177.0" },
  },
});

describe("legacyShadowCacheEnabled", () => {
  it("is ON unless the env var explicitly opts out", () => {
    // Unset and empty both mean "the user never expressed a preference" — the cache is a
    // default-on optimization, not a feature flag.
    expect(legacyShadowCacheEnabled({})).toBe(true);
    expect(legacyShadowCacheEnabled({ SUPABASE_SHADOW_CACHE: "" })).toBe(true);
    // A value that IS set goes through the repo's `viper.GetBool` parser.
    expect(legacyShadowCacheEnabled({ SUPABASE_SHADOW_CACHE: "0" })).toBe(false);
    expect(legacyShadowCacheEnabled({ SUPABASE_SHADOW_CACHE: "false" })).toBe(false);
    expect(legacyShadowCacheEnabled({ SUPABASE_SHADOW_CACHE: "no" })).toBe(false);
    expect(legacyShadowCacheEnabled({ SUPABASE_SHADOW_CACHE: "1" })).toBe(true);
    expect(legacyShadowCacheEnabled({ SUPABASE_SHADOW_CACHE: "true" })).toBe(true);
    expect(legacyShadowCacheEnabled({ SUPABASE_SHADOW_CACHE: "TRUE" })).toBe(true);
  });

  it("honors an opt-out set only in the project dotenv values", () => {
    // `supabase/.env` is loaded into `projectEnvValues` (ambient-wins merge, upstream), not into
    // `process.env` — the gate must consult it, same as the registry override does.
    expect(legacyShadowCacheEnabled({}, { SUPABASE_SHADOW_CACHE: "false" })).toBe(false);
    expect(legacyShadowCacheEnabled({}, { SUPABASE_SHADOW_CACHE: "1" })).toBe(true);
    expect(legacyShadowCacheEnabled({}, {})).toBe(true);
    // The record's own value is what counts once present — upstream merging already applied
    // ambient-wins precedence when building it.
    expect(
      legacyShadowCacheEnabled({ SUPABASE_SHADOW_CACHE: "1" }, { SUPABASE_SHADOW_CACHE: "0" }),
    ).toBe(false);
  });
});

describe("legacyShadowCacheKey", () => {
  it("is stable for identical inputs and independent of object key order", () => {
    const first = legacyShadowCacheKey(baseKeyInputs());
    expect(legacyShadowCacheKey(baseKeyInputs())).toBe(first);
    expect(
      legacyShadowCacheKey({
        ...baseKeyInputs(),
        dbSettings: { max_connections: 100, effective_cache_size: "128MB" },
      }),
    ).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{16}$/u);
    expect(legacyShadowBaselineTarFileName(first)).toBe(`shadow-baseline-${first}.tar`);
  });

  it("changes when ANY baked-in input changes", () => {
    const base = baseKeyInputs();
    const mutations: ReadonlyArray<{
      readonly label: string;
      readonly inputs: LegacyShadowCacheKeyInputs;
    }> = [
      { label: "postgres image tag", inputs: { ...base, postgresImage: "postgres:17.6.1.159" } },
      { label: "major version", inputs: { ...base, majorVersion: 15 } },
      { label: "shadow port", inputs: { ...base, shadowPort: 54321 } },
      { label: "jwt secret", inputs: { ...base, jwtSecret: "other-secret" } },
      { label: "jwt expiry", inputs: { ...base, jwtExpiry: 7200 } },
      { label: "root key", inputs: { ...base, rootKey: "0000" } },
      { label: "db password", inputs: { ...base, dbPassword: "hunter2" } },
      { label: "db settings", inputs: { ...base, dbSettings: { max_connections: 200 } } },
      {
        label: "auto expose new tables",
        inputs: { ...base, autoExposeNewTables: Option.some(true) },
      },
      {
        label: "auto expose new tables (explicit false vs unset)",
        inputs: { ...base, autoExposeNewTables: Option.some(false) },
      },
      { label: "roles.sql", inputs: { ...base, rolesSql: "" } },
      {
        label: "storage migration pin (storage enabled, majorVersion >= 15)",
        inputs: { ...base, storageTargetMigration: "20250607080910" },
      },
      {
        label: "storage migration pin (pinned vs unpinned)",
        inputs: { ...base, storageTargetMigration: "" },
      },
      {
        label: "jwks (realtime enabled, majorVersion >= 15)",
        inputs: { ...base, jwks: '{"keys":["rotated"]}' },
      },
      {
        label: "vault secret name",
        inputs: { ...base, vault: [{ name: "other", value: "value", resolved: true }] },
      },
      {
        label: "vault secret value",
        inputs: { ...base, vault: [{ name: "secret", value: "rotated", resolved: true }] },
      },
      {
        label: "realtime image",
        inputs: {
          ...base,
          services: { ...base.services, realtime: { enabled: true, image: "realtime:next" } },
        },
      },
      {
        label: "storage image",
        inputs: {
          ...base,
          services: { ...base.services, storage: { enabled: true, image: "storage:next" } },
        },
      },
      {
        label: "auth image",
        inputs: {
          ...base,
          services: { ...base.services, auth: { enabled: true, image: "gotrue:next" } },
        },
      },
      {
        label: "realtime enabled flag",
        inputs: {
          ...base,
          services: {
            ...base.services,
            realtime: { enabled: false, image: base.services.realtime.image },
          },
        },
      },
      {
        label: "storage enabled flag",
        inputs: {
          ...base,
          services: {
            ...base.services,
            storage: { enabled: false, image: base.services.storage.image },
          },
        },
      },
      {
        label: "auth enabled flag",
        inputs: {
          ...base,
          services: { ...base.services, auth: { enabled: false, image: base.services.auth.image } },
        },
      },
    ];
    const baseKey = legacyShadowCacheKey(base);
    const seen = new Map<string, string>([[baseKey, "base"]]);
    for (const mutation of mutations) {
      const key = legacyShadowCacheKey(mutation.inputs);
      const collision = seen.get(key);
      expect(collision, `${mutation.label} must change the cache key`).toBeUndefined();
      seen.set(key, mutation.label);
    }
  });

  it("excludes a disabled service's image tag entirely", () => {
    const base = baseKeyInputs();
    const withRealtimeA: LegacyShadowCacheKeyInputs = {
      ...base,
      services: { ...base.services, realtime: { enabled: false, image: "supabase/realtime:v1" } },
    };
    const withRealtimeB: LegacyShadowCacheKeyInputs = {
      ...base,
      services: { ...base.services, realtime: { enabled: false, image: "supabase/realtime:v2" } },
    };
    expect(legacyShadowCacheKey(withRealtimeA)).toBe(legacyShadowCacheKey(withRealtimeB));
  });

  it("excludes the resolved jwks when realtime is disabled", () => {
    const base = baseKeyInputs();
    const disabledRealtime: LegacyShadowCacheKeyInputs = {
      ...base,
      services: {
        ...base.services,
        realtime: { ...base.services.realtime, enabled: false },
      },
    };
    const withJwksA: LegacyShadowCacheKeyInputs = { ...disabledRealtime, jwks: '{"keys":["a"]}' };
    const withJwksB: LegacyShadowCacheKeyInputs = { ...disabledRealtime, jwks: '{"keys":["b"]}' };
    expect(legacyShadowCacheKey(withJwksA)).toBe(legacyShadowCacheKey(withJwksB));
  });

  it("excludes the resolved jwks when majorVersion is below 15, even with realtime enabled", () => {
    const base = baseKeyInputs();
    const pre15: LegacyShadowCacheKeyInputs = { ...base, majorVersion: 14 };
    const withJwksA: LegacyShadowCacheKeyInputs = { ...pre15, jwks: '{"keys":["a"]}' };
    const withJwksB: LegacyShadowCacheKeyInputs = { ...pre15, jwks: '{"keys":["b"]}' };
    expect(legacyShadowCacheKey(withJwksA)).toBe(legacyShadowCacheKey(withJwksB));
  });

  it("excludes the storage migration pin when storage is disabled", () => {
    const base = baseKeyInputs();
    const disabledStorage: LegacyShadowCacheKeyInputs = {
      ...base,
      services: {
        ...base.services,
        storage: { ...base.services.storage, enabled: false },
      },
    };
    const withPinA: LegacyShadowCacheKeyInputs = {
      ...disabledStorage,
      storageTargetMigration: "20240101000000",
    };
    const withPinB: LegacyShadowCacheKeyInputs = {
      ...disabledStorage,
      storageTargetMigration: "20250607080910",
    };
    expect(legacyShadowCacheKey(withPinA)).toBe(legacyShadowCacheKey(withPinB));
  });

  it("excludes the storage migration pin when majorVersion is below 15, even with storage enabled", () => {
    const base = baseKeyInputs();
    const pre15: LegacyShadowCacheKeyInputs = { ...base, majorVersion: 14 };
    const withPinA: LegacyShadowCacheKeyInputs = { ...pre15, storageTargetMigration: "a" };
    const withPinB: LegacyShadowCacheKeyInputs = { ...pre15, storageTargetMigration: "b" };
    expect(legacyShadowCacheKey(withPinA)).toBe(legacyShadowCacheKey(withPinB));
  });

  it("hashes vault secrets in a name-stable order", () => {
    const base = baseKeyInputs();
    const ascending = legacyShadowCacheKey({
      ...base,
      vault: [
        { name: "a", value: "1", resolved: true },
        { name: "b", value: "2", resolved: true },
      ],
    });
    const descending = legacyShadowCacheKey({
      ...base,
      vault: [
        { name: "b", value: "2", resolved: true },
        { name: "a", value: "1", resolved: true },
      ],
    });
    expect(ascending).toBe(descending);
  });
});
describe("shadow baseline tar retention", () => {
  const key = "0123456789abcdef";

  it("keeps the current key's snapshot and sweeps every other key's", () => {
    expect(legacyIsStaleShadowBaselineTar(legacyShadowBaselineTarFileName(key), key)).toBe(false);
    expect(legacyIsStaleShadowBaselineTar("shadow-baseline-fedcba9876543210.tar", key)).toBe(true);
  });

  it("never sweeps a file that is not one of this module's own snapshots", () => {
    // `supabase/.temp/pgdelta/` is shared with the pg-delta catalog cache and its debug bundles —
    // the retention rule must be blind to everything but its own prefix AND suffix, or a `db diff`
    // would delete the catalog cache it depends on.
    for (const other of [
      "catalog-local-migrations-abc-123.json",
      "shadow-baseline.tar",
      `shadow-baseline-${key}.tar.4242.partial`,
      `shadow-cache-${key}.json`,
      "pgdelta-debug.zip",
    ]) {
      expect(legacyIsStaleShadowBaselineTar(other, key), other).toBe(false);
    }
  });
});
