import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { resolveSetupWebhooksEnabled } from "./db-setup.ts";
import {
  SHADOW_BASELINE_KEEP,
  SHADOW_BASELINE_MAX_AGE_MS,
  isShadowBaselinePartial,
  isShadowBaselineTar,
  shadowBaselineTarFileName,
  shadowBaselineTarsToEvict,
  shadowCacheKey,
  type ShadowCacheKeyInputs,
} from "./shadow-cache.ts";

const baseKeyInputs = (): ShadowCacheKeyInputs => ({
  postgresImage: "public.ecr.aws/supabase/postgres:17.6.1.158",
  majorVersion: 17,
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwtExpiry: 3600,
  rootKey: "d4dc5b6d4a1d6a10b2c1e5b6a7c8d9e0",
  dbPassword: "postgres",
  dbSettings: { effective_cache_size: "128MB", max_connections: 100 },
  autoExposeNewTables: Option.none(),
  storageTargetMigration: "20240101000000",
  webhooksEnabled: true,
  rolesSql: "create role custom_role;\n",
  vault: [{ name: "secret", value: "value", resolved: true }],
  jwks: '{"keys":[]}',
  services: {
    realtime: { enabled: true, image: "supabase/realtime:v2.34.47" },
    storage: { enabled: true, image: "supabase/storage-api:v1.25.7" },
    auth: { enabled: true, image: "supabase/gotrue:v2.177.0" },
  },
});

describe("resolveSetupWebhooksEnabled", () => {
  it("matches setupDatabase: enabled/disabled override config, config follows the flag", () => {
    expect(resolveSetupWebhooksEnabled("enabled", false)).toBe(true);
    expect(resolveSetupWebhooksEnabled("enabled", true)).toBe(true);
    expect(resolveSetupWebhooksEnabled("disabled", true)).toBe(false);
    expect(resolveSetupWebhooksEnabled("disabled", false)).toBe(false);
    expect(resolveSetupWebhooksEnabled("config", true)).toBe(true);
    expect(resolveSetupWebhooksEnabled("config", false)).toBe(false);
    expect(resolveSetupWebhooksEnabled(undefined, true)).toBe(true);
    expect(resolveSetupWebhooksEnabled(undefined, false)).toBe(false);
  });
});

describe("shadowCacheKey", () => {
  it("is stable for identical inputs and independent of object key order", () => {
    const first = shadowCacheKey(baseKeyInputs());
    expect(shadowCacheKey(baseKeyInputs())).toBe(first);
    expect(
      shadowCacheKey({
        ...baseKeyInputs(),
        dbSettings: { max_connections: 100, effective_cache_size: "128MB" },
      }),
    ).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{16}$/u);
    expect(shadowBaselineTarFileName(first)).toBe(`shadow-baseline-${first}.tar`);
  });

  // Each variant performs an intentionally expensive scrypt derivation; parallel suite load needs headroom.
  it("changes when ANY baked-in input changes", { timeout: 30_000 }, () => {
    const base = baseKeyInputs();
    const mutations: ReadonlyArray<{
      readonly label: string;
      readonly inputs: ShadowCacheKeyInputs;
    }> = [
      { label: "postgres image tag", inputs: { ...base, postgresImage: "postgres:17.6.1.159" } },
      { label: "major version", inputs: { ...base, majorVersion: 15 } },
      { label: "jwt secret", inputs: { ...base, jwtSecret: "other-secret" } },
      { label: "jwt expiry", inputs: { ...base, jwtExpiry: 7200 } },
      { label: "root key", inputs: { ...base, rootKey: "0000" } },
      { label: "db password", inputs: { ...base, dbPassword: "hunter2" } },
      { label: "db settings", inputs: { ...base, dbSettings: { max_connections: 200 } } },
      {
        label: "auto expose new tables",
        inputs: { ...base, autoExposeNewTables: Option.some(false) },
      },
      { label: "effective webhooks / pg_net", inputs: { ...base, webhooksEnabled: false } },
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
    const baseKey = shadowCacheKey(base);
    const seen = new Map<string, string>([[baseKey, "base"]]);
    for (const mutation of mutations) {
      const key = shadowCacheKey(mutation.inputs);
      const collision = seen.get(key);
      expect(collision, `${mutation.label} must change the cache key`).toBeUndefined();
      seen.set(key, mutation.label);
    }
  });

  it("collapses auto_expose_new_tables to the behavior applyApiPrivileges actually takes", () => {
    const base = baseKeyInputs();
    const unset = shadowCacheKey({ ...base, autoExposeNewTables: Option.none() });
    const explicitTrue = shadowCacheKey({ ...base, autoExposeNewTables: Option.some(true) });
    const explicitFalse = shadowCacheKey({
      ...base,
      autoExposeNewTables: Option.some(false),
    });
    expect(explicitTrue).toBe(unset);
    expect(explicitFalse).not.toBe(unset);
  });

  it("excludes a disabled service's image tag entirely", () => {
    const base = baseKeyInputs();
    const withRealtimeA: ShadowCacheKeyInputs = {
      ...base,
      services: { ...base.services, realtime: { enabled: false, image: "supabase/realtime:v1" } },
    };
    const withRealtimeB: ShadowCacheKeyInputs = {
      ...base,
      services: { ...base.services, realtime: { enabled: false, image: "supabase/realtime:v2" } },
    };
    expect(shadowCacheKey(withRealtimeA)).toBe(shadowCacheKey(withRealtimeB));
  });

  it("excludes the resolved jwks when realtime is disabled", () => {
    const base = baseKeyInputs();
    const disabledRealtime: ShadowCacheKeyInputs = {
      ...base,
      services: {
        ...base.services,
        realtime: { ...base.services.realtime, enabled: false },
      },
    };
    const withJwksA: ShadowCacheKeyInputs = { ...disabledRealtime, jwks: '{"keys":["a"]}' };
    const withJwksB: ShadowCacheKeyInputs = { ...disabledRealtime, jwks: '{"keys":["b"]}' };
    expect(shadowCacheKey(withJwksA)).toBe(shadowCacheKey(withJwksB));
  });

  it("excludes the resolved jwks when majorVersion is below 15, even with realtime enabled", () => {
    const base = baseKeyInputs();
    const pre15: ShadowCacheKeyInputs = { ...base, majorVersion: 14 };
    const withJwksA: ShadowCacheKeyInputs = { ...pre15, jwks: '{"keys":["a"]}' };
    const withJwksB: ShadowCacheKeyInputs = { ...pre15, jwks: '{"keys":["b"]}' };
    expect(shadowCacheKey(withJwksA)).toBe(shadowCacheKey(withJwksB));
  });

  it("excludes the storage migration pin when storage is disabled", () => {
    const base = baseKeyInputs();
    const disabledStorage: ShadowCacheKeyInputs = {
      ...base,
      services: {
        ...base.services,
        storage: { ...base.services.storage, enabled: false },
      },
    };
    const withPinA: ShadowCacheKeyInputs = {
      ...disabledStorage,
      storageTargetMigration: "20240101000000",
    };
    const withPinB: ShadowCacheKeyInputs = {
      ...disabledStorage,
      storageTargetMigration: "20250607080910",
    };
    expect(shadowCacheKey(withPinA)).toBe(shadowCacheKey(withPinB));
  });

  it("excludes the storage migration pin when majorVersion is below 15, even with storage enabled", () => {
    const base = baseKeyInputs();
    const pre15: ShadowCacheKeyInputs = { ...base, majorVersion: 14 };
    const withPinA: ShadowCacheKeyInputs = { ...pre15, storageTargetMigration: "a" };
    const withPinB: ShadowCacheKeyInputs = { ...pre15, storageTargetMigration: "b" };
    expect(shadowCacheKey(withPinA)).toBe(shadowCacheKey(withPinB));
  });

  it("cannot collide scalar fields across line boundaries", () => {
    const base = baseKeyInputs();
    // rootKey's tail mimics a `db_password` line to try to forge the next payload line.
    const left = shadowCacheKey({
      ...base,
      rootKey: 'p"\ndb_password="q',
      dbPassword: "r",
    });
    const right = shadowCacheKey({
      ...base,
      rootKey: "p",
      dbPassword: 'q"\ndb_password="r',
    });
    expect(left).not.toBe(right);
  });

  it("excludes unresolved vault secrets, which the upsert never processes", () => {
    const base = baseKeyInputs();
    const withUnresolved = shadowCacheKey({
      ...base,
      vault: [...base.vault, { name: "pending", value: "", resolved: false }],
    });
    expect(withUnresolved).toBe(shadowCacheKey(base));
    // A resolved empty value still lands in the cluster and must re-key.
    const withResolvedEmpty = shadowCacheKey({
      ...base,
      vault: [...base.vault, { name: "pending", value: "", resolved: true }],
    });
    expect(withResolvedEmpty).not.toBe(shadowCacheKey(base));
  });

  it("cannot collide vault name/value pairs across the tuple boundary", () => {
    const base = baseKeyInputs();
    // `name=a=b, value=c` and `name=a, value=b=c` would collide under a bare `=`-joined encoding.
    const left = shadowCacheKey({
      ...base,
      vault: [{ name: "a=b", value: "c", resolved: true }],
    });
    const right = shadowCacheKey({
      ...base,
      vault: [{ name: "a", value: "b=c", resolved: true }],
    });
    expect(left).not.toBe(right);
  });

  it("hashes vault secrets in a name-stable order", () => {
    const base = baseKeyInputs();
    const ascending = shadowCacheKey({
      ...base,
      vault: [
        { name: "a", value: "1", resolved: true },
        { name: "b", value: "2", resolved: true },
      ],
    });
    const descending = shadowCacheKey({
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
  const now = 1_700_000_000_000;

  it("recognizes only this module's own published snapshots", () => {
    expect(isShadowBaselineTar(shadowBaselineTarFileName(key))).toBe(true);
    for (const other of [
      "catalog-local-migrations-abc-123.json",
      "shadow-baseline.tar",
      `shadow-baseline-${key}.tar.4242.partial`,
      `shadow-cache-${key}.json`,
      "pgdelta-debug.zip",
      // Wrong key length / non-hex.
      "shadow-baseline-0123456789abcde.tar",
      "shadow-baseline-0123456789abcdefg.tar",
      "shadow-baseline-0123456789ABCDEF.tar",
    ]) {
      expect(isShadowBaselineTar(other), other).toBe(false);
    }
  });

  it("recognizes only this module's own partial temp files as abandoned-sweep candidates", () => {
    expect(isShadowBaselinePartial(`shadow-baseline-${key}.tar.4242.partial`)).toBe(true);
    for (const other of [
      shadowBaselineTarFileName(key),
      "shadow-baseline-fedcba9876543210.tar",
      "shadow-baseline.tar.4242.partial",
      `shadow-baseline-${key}.tar.partial`,
      `shadow-baseline-${key}.tar.4242.partial.bak`,
      "catalog-local-migrations-abc-123.json",
    ]) {
      expect(isShadowBaselinePartial(other), other).toBe(false);
    }
  });

  it("evicts aged tars and keeps the newest N among survivors", () => {
    const aged = now - SHADOW_BASELINE_MAX_AGE_MS - 1;
    const fresh = now - 1_000;
    const entries = [
      { fileName: shadowBaselineTarFileName("aaaaaaaaaaaaaaaa"), mtimeMs: aged },
      { fileName: shadowBaselineTarFileName("bbbbbbbbbbbbbbbb"), mtimeMs: fresh },
      { fileName: shadowBaselineTarFileName("cccccccccccccccc"), mtimeMs: fresh - 10 },
      { fileName: "catalog-abc.json", mtimeMs: aged },
      { fileName: `shadow-baseline-${key}.tar.1.partial`, mtimeMs: aged },
    ];
    expect(
      shadowBaselineTarsToEvict(entries, now, {
        keep: 1,
        maxAgeMs: SHADOW_BASELINE_MAX_AGE_MS,
      }),
    ).toEqual([
      shadowBaselineTarFileName("aaaaaaaaaaaaaaaa"),
      shadowBaselineTarFileName("cccccccccccccccc"),
    ]);
  });

  it("evicts the oldest beyond the keep cap when all are fresh", () => {
    const entries = Array.from({ length: SHADOW_BASELINE_KEEP + 2 }, (_, index) => ({
      fileName: shadowBaselineTarFileName(index.toString(16).padStart(16, "0")),
      mtimeMs: now - index * 1_000,
    }));
    const evicted = shadowBaselineTarsToEvict(entries, now);
    expect(evicted).toHaveLength(2);
    expect(evicted).toContain(
      shadowBaselineTarFileName(SHADOW_BASELINE_KEEP.toString(16).padStart(16, "0")),
    );
    expect(evicted).toContain(
      shadowBaselineTarFileName((SHADOW_BASELINE_KEEP + 1).toString(16).padStart(16, "0")),
    );
  });

  it("never evicts the current key, even when it is aged or over the cap", () => {
    const current = shadowBaselineTarFileName("dddddddddddddddd");
    const aged = now - SHADOW_BASELINE_MAX_AGE_MS - 1;
    const evicted = shadowBaselineTarsToEvict(
      [
        { fileName: current, mtimeMs: aged },
        { fileName: shadowBaselineTarFileName("aaaaaaaaaaaaaaaa"), mtimeMs: now - 1_000 },
        { fileName: shadowBaselineTarFileName("bbbbbbbbbbbbbbbb"), mtimeMs: now - 2_000 },
        { fileName: shadowBaselineTarFileName("cccccccccccccccc"), mtimeMs: now - 3_000 },
        { fileName: shadowBaselineTarFileName("eeeeeeeeeeeeeeee"), mtimeMs: now - 4_000 },
      ],
      now,
      { retainFileName: current },
    );
    expect(evicted).not.toContain(current);
    expect(evicted).toContain(shadowBaselineTarFileName("eeeeeeeeeeeeeeee"));
  });

  it("drops a 4th young tar once the keep cap is full", () => {
    const entries = Array.from({ length: 4 }, (_, index) => ({
      fileName: shadowBaselineTarFileName(index.toString(16).padStart(16, "0")),
      mtimeMs: now - index * 1_000,
    }));
    expect(shadowBaselineTarsToEvict(entries, now)).toEqual([
      shadowBaselineTarFileName("0000000000000003"),
    ]);
  });

  it("never returns a file that is not one of this module's own snapshots", () => {
    expect(
      shadowBaselineTarsToEvict(
        [
          { fileName: "catalog-local-migrations-abc-123.json", mtimeMs: 0 },
          { fileName: "shadow-baseline.tar", mtimeMs: 0 },
          { fileName: `shadow-baseline-${key}.tar.4242.partial`, mtimeMs: 0 },
          { fileName: `shadow-cache-${key}.json`, mtimeMs: 0 },
          { fileName: "pgdelta-debug.zip", mtimeMs: 0 },
        ],
        now,
      ),
    ).toEqual([]);
  });
});
