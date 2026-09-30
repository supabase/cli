import { CliConfigSchema } from "@supabase/config";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import type { ShadowSetupInput } from "./db-bootstrap/shadow-database.ts";
import { stackShadowCacheEntry } from "./stack-shadow-cache.ts";

const defaultConfig = Schema.decodeUnknownSync(CliConfigSchema)({});

const input = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  setupOverrides: Partial<ShadowSetupInput<never>["setup"]> = {},
  inputOverrides: Partial<Pick<ShadowSetupInput<never>, "password">> = {},
): ShadowSetupInput<never> => ({
  db: { major_version: 17, settings: {} },
  experimental: defaultConfig.experimental,
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwtExpiry: 3600,
  networkId: "n",
  image: "stack-ephemeral",
  configImage: "stack-ephemeral",
  shadowPort: 54320,
  password: inputOverrides.password ?? "postgres",
  projectId: "proj",
  isBitbucketPipeline: false,
  workdir,
  extraHosts: [],
  fs,
  path,
  hostname: "127.0.0.1",
  healthTimeoutSeconds: 60,
  setup: {
    majorVersion: 17,
    config: defaultConfig,
    dbUrl: "postgresql://postgres:postgres@127.0.0.1:54320/postgres",
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    jwks: Effect.succeed("{}"),
    apiUrl: "http://127.0.0.1:54321",
    authExternalUrl: undefined,
    siteUrl: "http://127.0.0.1:3000",
    anonKey: "anon",
    serviceRoleKey: "service",
    storageTargetMigration: "",
    realtimeEnabledForSetup: false,
    storageEnabledForSetup: false,
    authEnabledForSetup: false,
    serviceVersionOverrides: {},
    projectEnvValues: { SUPABASE_SHADOW_CACHE: "1" },
    debug: false,
    webhooksEnabled: false,
    apiAutoExposeNewTables: Option.none(),
    vault: [],
    ...setupOverrides,
  },
});

describe("stack shadow cache entry", () => {
  it.effect("rekeys roles, webhook policy, and password, and honors both cache gates", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-shadow-cache-entry-" });
      yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });

      const base = input(fs, path, root);
      const first = yield* stackShadowCacheEntry(base, "native", "darwin", "arm64", "config");
      if (first === undefined) return yield* Effect.die("cache entry unexpectedly disabled");

      yield* fs.writeFileString(
        path.join(root, "supabase", "roles.sql"),
        "CREATE ROLE cache_probe;\n",
      );
      const withRoles = yield* stackShadowCacheEntry(base, "native", "darwin", "arm64", "config");
      if (withRoles === undefined) return yield* Effect.die("roles entry unexpectedly disabled");
      expect(withRoles.key).not.toBe(first.key);

      const withWebhooks = yield* stackShadowCacheEntry(
        input(fs, path, root, { webhooksEnabled: true }),
        "native",
        "darwin",
        "arm64",
        "config",
      );
      if (withWebhooks === undefined)
        return yield* Effect.die("webhooks entry unexpectedly disabled");
      expect(withWebhooks.key).not.toBe(withRoles.key);

      const withPassword = yield* stackShadowCacheEntry(
        input(fs, path, root, {}, { password: "rotated-password" }),
        "native",
        "darwin",
        "arm64",
        "config",
      );
      if (withPassword === undefined)
        return yield* Effect.die("password entry unexpectedly disabled");
      expect(withPassword.key).not.toBe(withRoles.key);

      expect(
        yield* stackShadowCacheEntry(base, "native", "darwin", "arm64", "config", true),
      ).toBeUndefined();
      expect(
        yield* stackShadowCacheEntry(
          input(fs, path, root, { projectEnvValues: { SUPABASE_SHADOW_CACHE: "0" } }),
          "native",
          "darwin",
          "arm64",
          "config",
        ),
      ).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
