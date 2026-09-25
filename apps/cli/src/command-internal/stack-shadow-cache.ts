import { Effect } from "effect";
import { resolveArtifact, postgresVersion } from "@supabase/stack/internal/artifacts";
import type { ShadowSetupInput } from "./db-bootstrap/shadow-database.ts";
import {
  SHADOW_CACHE_ENV,
  shadowCacheKey,
  type ShadowCacheKeyInputs,
} from "./db-bootstrap/shadow-cache.ts";
import { resolveSetupWebhooksEnabled, type SetupDatabaseOptions } from "./db-bootstrap/db-setup.ts";
import { viperEnvBoolWithProjectFallback } from "./viper-env.ts";

interface StackShadowCacheEntry {
  readonly key: string;
  readonly rolesSql: string;
}

const readRoles = (input: ShadowSetupInput<unknown>) =>
  Effect.gen(function* () {
    const file = input.path.join(input.workdir, "supabase", "roles.sql");
    if (!(yield* input.fs.exists(file))) return "";
    return yield* input.fs.readFileString(file);
  });

export const stackShadowCacheEntry = Effect.fn("StackShadowCache.entry")(function* (
  input: ShadowSetupInput<unknown>,
  runtime: string,
  platform: string,
  arch: string,
  webhooks: SetupDatabaseOptions["webhooks"],
  bypassCache = false,
) {
  if (
    bypassCache ||
    !viperEnvBoolWithProjectFallback(SHADOW_CACHE_ENV, input.setup.projectEnvValues ?? {}, {
      whenUnset: true,
    })
  )
    return undefined;
  const rolesSql = yield* readRoles(input);
  const postgres = yield* resolveArtifact({
    service: "database",
    version: postgresVersion(String(input.setup.majorVersion)),
  });
  const image = (service: "auth" | "storage" | "realtime", enabled: boolean) =>
    enabled ? resolveArtifact({ service }) : Effect.succeed({ image: "", version: "" });
  const [auth, storage, realtime] = yield* Effect.all([
    image("auth", input.setup.authEnabledForSetup),
    image("storage", input.setup.storageEnabledForSetup),
    image("realtime", input.setup.realtimeEnabledForSetup),
  ]);
  const keyInputs: ShadowCacheKeyInputs = {
    postgresImage: JSON.stringify(["stack-v1", runtime, platform, arch, postgres.image]),
    majorVersion: input.setup.majorVersion,
    jwtSecret: input.jwtSecret,
    jwtExpiry: input.jwtExpiry,
    rootKey: input.rootKey ?? "<stack-generated-root-key>",
    dbPassword: input.password,
    storageTargetMigration: "",
    dbSettings: input.db.settings,
    autoExposeNewTables: input.setup.apiAutoExposeNewTables,
    webhooksEnabled: resolveSetupWebhooksEnabled(webhooks, input.setup.webhooksEnabled),
    rolesSql,
    vault: input.setup.vault,
    jwks: "",
    services: {
      auth: { enabled: input.setup.authEnabledForSetup, image: auth.image },
      storage: { enabled: input.setup.storageEnabledForSetup, image: storage.image },
      realtime: { enabled: input.setup.realtimeEnabledForSetup, image: realtime.image },
    },
  };
  const key = shadowCacheKey(keyInputs);
  return {
    key,
    rolesSql,
  } satisfies StackShadowCacheEntry;
});

export const stackShadowCacheRoles = readRoles;
