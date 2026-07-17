import { STACK_SERVICE_NAMES } from "@supabase/stack/effect";
import type { StackConfig, StackServiceName, VersionManifest } from "@supabase/stack/effect";

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
export const startModes = ["native", "auto", "docker"] as const;
export type StartMode = (typeof startModes)[number];

export function toStartStackConfig(
  exclude: ReadonlyArray<ExcludedStackService>,
  mode: StartMode,
): StackConfig {
  const excluded = new Set<string>(exclude);
  if (excluded.has("storage")) excluded.add("imgproxy");
  if (excluded.has("pgmeta")) excluded.add("studio");
  if (excluded.has("analytics")) excluded.add("vector");
  const services = STACK_SERVICE_NAMES.filter(
    (service) => service !== "edge-runtime" || mode !== "native",
  ).filter((service) => !excluded.has(service));
  return {
    mode,
    services,
  };
}

const hasService = (stackConfig: StackConfig, service: StackServiceName): boolean =>
  stackConfig.services?.includes(service) ?? false;

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
      !hasService(stackConfig, "postgrest") || versions.postgrest === undefined
        ? stackConfig.postgrest
        : { ...stackConfig.postgrest, version: versions.postgrest },
    auth:
      !hasService(stackConfig, "auth") || versions.auth === undefined
        ? stackConfig.auth
        : { ...stackConfig.auth, version: versions.auth },
    realtime:
      !hasService(stackConfig, "realtime") || versions.realtime === undefined
        ? stackConfig.realtime
        : { ...stackConfig.realtime, version: versions.realtime },
    storage:
      !hasService(stackConfig, "storage") || versions.storage === undefined
        ? stackConfig.storage
        : { ...stackConfig.storage, version: versions.storage },
    imgproxy:
      !hasService(stackConfig, "imgproxy") || versions.imgproxy === undefined
        ? stackConfig.imgproxy
        : { ...stackConfig.imgproxy, version: versions.imgproxy },
    mailpit:
      !hasService(stackConfig, "mailpit") || versions.mailpit === undefined
        ? stackConfig.mailpit
        : { ...stackConfig.mailpit, version: versions.mailpit },
    pgmeta:
      !hasService(stackConfig, "pgmeta") || versions.pgmeta === undefined
        ? stackConfig.pgmeta
        : { ...stackConfig.pgmeta, version: versions.pgmeta },
    studio:
      !hasService(stackConfig, "studio") || versions.studio === undefined
        ? stackConfig.studio
        : { ...stackConfig.studio, version: versions.studio },
    analytics:
      !hasService(stackConfig, "analytics") || versions.analytics === undefined
        ? stackConfig.analytics
        : { ...stackConfig.analytics, version: versions.analytics },
    vector:
      !hasService(stackConfig, "vector") || versions.vector === undefined
        ? stackConfig.vector
        : { ...stackConfig.vector, version: versions.vector },
    pooler:
      !hasService(stackConfig, "pooler") || versions.pooler === undefined
        ? stackConfig.pooler
        : { ...stackConfig.pooler, version: versions.pooler },
  };
}
