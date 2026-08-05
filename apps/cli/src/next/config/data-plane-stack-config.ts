import type { LoadedProjectConfig, ProjectConfig, ProjectEnvironment } from "@supabase/config";
import type { StackConfig } from "@supabase/stack/effect";
import { resolveAnalyticsStackConfig } from "./analytics-stack-config.ts";
import { resolvePoolerStackConfig } from "./pooler-stack-config.ts";
import { resolveRealtimeStackConfig } from "./realtime-stack-config.ts";
import { resolveStorageStackConfig } from "./storage-stack-config.ts";
import { resolveStudioStackConfig } from "./studio-stack-config.ts";

export function resolveDataPlaneStackConfig(input: {
  readonly loadedProjectConfig: LoadedProjectConfig | null;
  readonly projectConfig: ProjectConfig;
  readonly projectEnvironment: ProjectEnvironment | null;
  readonly configDir: string;
  readonly base: StackConfig;
}): StackConfig {
  return {
    ...input.base,
    realtime: resolveRealtimeStackConfig({
      config: input.projectConfig.realtime,
      loaded: input.loadedProjectConfig,
      environment: input.projectEnvironment,
      base: input.base.realtime,
    }),
    storage: resolveStorageStackConfig({
      config: input.projectConfig.storage,
      loaded: input.loadedProjectConfig,
      environment: input.projectEnvironment,
      base: input.base.storage,
    }),
    analytics: resolveAnalyticsStackConfig({
      config: input.projectConfig.analytics,
      loaded: input.loadedProjectConfig,
      environment: input.projectEnvironment,
      configDir: input.configDir,
      base: input.base.analytics,
    }),
    studio: resolveStudioStackConfig({
      config: input.projectConfig.studio,
      loaded: input.loadedProjectConfig,
      environment: input.projectEnvironment,
      base: input.base.studio,
    }),
    pooler: resolvePoolerStackConfig({
      config: input.projectConfig.db.pooler,
      loaded: input.loadedProjectConfig,
      environment: input.projectEnvironment,
      base: input.base.pooler,
    }),
  };
}
