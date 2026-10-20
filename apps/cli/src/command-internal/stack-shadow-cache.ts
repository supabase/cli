import { Effect, Schema } from "effect";
import type { ArtifactPin, ArtifactSelection } from "@supabase/stack/internal/artifacts";
import type { ShadowSetupInput } from "./db-bootstrap/shadow-database.ts";
import {
  SHADOW_CACHE_ENV,
  shadowCacheKey,
  type ShadowCacheKeyInputs,
} from "./db-bootstrap/shadow-cache.ts";
import { resolveSetupWebhooksEnabled, type SetupDatabaseOptions } from "./db-bootstrap/db-setup.ts";
import { viperEnvBoolWithProjectFallback } from "./viper-env.ts";

const encodeKeyParts = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

interface StackShadowCacheEntry {
  readonly key: string;
  readonly rolesSql: string;
}

/** Identifies the exact artifact build, so a version or revision bump never reuses a baseline. */
const pinKey = (pin: ArtifactPin) =>
  encodeKeyParts([pin.upstreamVersion, String(pin.revision), pin.image]);

const readRoles = (input: ShadowSetupInput<unknown>) =>
  Effect.gen(function* () {
    const file = input.path.join(input.workdir, "supabase", "roles.sql");
    if (!(yield* input.fs.exists(file))) return "";
    return yield* input.fs.readFileString(file);
  });

export const stackShadowCacheEntry = Effect.fn("StackShadowCache.entry")(function* (
  input: ShadowSetupInput<unknown>,
  selection: ArtifactSelection,
  runtime: string,
  platform: string,
  arch: string,
  webhooks: SetupDatabaseOptions["webhooks"],
  bypassCache = false,
) {
  if (
    bypassCache ||
    !(yield* viperEnvBoolWithProjectFallback(SHADOW_CACHE_ENV, input.setup.projectEnvValues ?? {}, {
      whenUnset: true,
    }))
  )
    return undefined;
  const rolesSql = yield* readRoles(input);
  const serviceKey = (pin: ArtifactPin, enabled: boolean) =>
    enabled ? pinKey(pin) : Effect.succeed("");
  const keyInputs: ShadowCacheKeyInputs = {
    postgresImage: yield* encodeKeyParts([
      "stack-v3",
      runtime,
      platform,
      arch,
      yield* pinKey(selection.database),
    ]),
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
      auth: {
        enabled: input.setup.authEnabledForSetup,
        image: yield* serviceKey(selection.auth, input.setup.authEnabledForSetup),
      },
      storage: {
        enabled: input.setup.storageEnabledForSetup,
        image: yield* serviceKey(selection.storage, input.setup.storageEnabledForSetup),
      },
      realtime: {
        enabled: input.setup.realtimeEnabledForSetup,
        image: yield* serviceKey(selection.realtime, input.setup.realtimeEnabledForSetup),
      },
    },
  };
  const key = shadowCacheKey(keyInputs);
  return {
    key,
    rolesSql,
  } satisfies StackShadowCacheEntry;
});

export const stackShadowCacheRoles = readRoles;
