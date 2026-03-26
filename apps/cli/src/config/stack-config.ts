import type { StackConfig, VersionManifest } from "@supabase/stack/effect";

export const excludedStackServices = [
  "auth",
  "postgrest",
  "realtime",
  "storage",
  "imgproxy",
  "mailpit",
  "pgmeta",
  "studio",
  "analytics",
  "vector",
  "pooler",
] as const;

export type ExcludedStackService = (typeof excludedStackServices)[number];

export function toStartStackConfig(exclude: ReadonlyArray<ExcludedStackService>): StackConfig {
  const excluded = new Set(exclude);
  return {
    mode: "auto",
    realtime: excluded.has("realtime") ? false : {},
    storage: excluded.has("storage") ? false : {},
    imgproxy: excluded.has("imgproxy") || excluded.has("storage") ? false : {},
    mailpit: excluded.has("mailpit") ? false : {},
    pgmeta: excluded.has("pgmeta") ? false : {},
    studio: excluded.has("studio") || excluded.has("pgmeta") ? false : {},
    analytics: excluded.has("analytics") ? false : {},
    vector: excluded.has("vector") || excluded.has("analytics") ? false : {},
    pooler: excluded.has("pooler") ? false : {},
    ...(excluded.has("auth") ? { auth: false } : {}),
    ...(excluded.has("postgrest") ? { postgrest: false } : {}),
  };
}

export function withServiceVersions(
  stackConfig: StackConfig,
  versions: Partial<VersionManifest>,
): StackConfig {
  return {
    ...stackConfig,
    postgres:
      versions.postgres === undefined
        ? stackConfig.postgres
        : { ...stackConfig.postgres, version: versions.postgres },
    postgrest:
      stackConfig.postgrest === false || versions.postgrest === undefined
        ? stackConfig.postgrest
        : { ...stackConfig.postgrest, version: versions.postgrest },
    auth:
      stackConfig.auth === false || versions.auth === undefined
        ? stackConfig.auth
        : { ...stackConfig.auth, version: versions.auth },
    realtime:
      stackConfig.realtime === false || versions.realtime === undefined
        ? stackConfig.realtime
        : { ...stackConfig.realtime, version: versions.realtime },
    storage:
      stackConfig.storage === false || versions.storage === undefined
        ? stackConfig.storage
        : { ...stackConfig.storage, version: versions.storage },
    imgproxy:
      stackConfig.imgproxy === false || versions.imgproxy === undefined
        ? stackConfig.imgproxy
        : { ...stackConfig.imgproxy, version: versions.imgproxy },
    mailpit:
      stackConfig.mailpit === false || versions.mailpit === undefined
        ? stackConfig.mailpit
        : { ...stackConfig.mailpit, version: versions.mailpit },
    pgmeta:
      stackConfig.pgmeta === false || versions.pgmeta === undefined
        ? stackConfig.pgmeta
        : { ...stackConfig.pgmeta, version: versions.pgmeta },
    studio:
      stackConfig.studio === false || versions.studio === undefined
        ? stackConfig.studio
        : { ...stackConfig.studio, version: versions.studio },
    analytics:
      stackConfig.analytics === false || versions.analytics === undefined
        ? stackConfig.analytics
        : { ...stackConfig.analytics, version: versions.analytics },
    vector:
      stackConfig.vector === false || versions.vector === undefined
        ? stackConfig.vector
        : { ...stackConfig.vector, version: versions.vector },
    pooler:
      stackConfig.pooler === false || versions.pooler === undefined
        ? stackConfig.pooler
        : { ...stackConfig.pooler, version: versions.pooler },
  };
}
