import type { LoadedProjectConfig, ProjectConfig, ProjectEnvironment } from "@supabase/config";
import type { PoolerConfig } from "@supabase/stack/effect";
import { resolveEnumOverride, resolveUintOverride } from "./data-plane-stack-config-values.ts";

export function resolvePoolerStackConfig(input: {
  readonly loaded: LoadedProjectConfig | null;
  readonly config: ProjectConfig["db"]["pooler"];
  readonly environment: ProjectEnvironment | null;
  readonly base: PoolerConfig | false | undefined;
}): PoolerConfig | false {
  const mode = resolveEnumOverride<"transaction" | "session">({
    loaded: input.loaded,
    environment: input.environment,
    configured: input.config.pool_mode,
    path: "db.pooler.pool_mode",
    values: ["transaction", "session"],
  });
  const defaultPoolSize = resolveUintOverride({
    loaded: input.loaded,
    environment: input.environment,
    configured: input.config.default_pool_size,
    path: "db.pooler.default_pool_size",
  });
  const maxClientConn = resolveUintOverride({
    loaded: input.loaded,
    environment: input.environment,
    configured: input.config.max_client_conn,
    path: "db.pooler.max_client_conn",
  });

  return input.base === false ? false : { ...input.base, mode, defaultPoolSize, maxClientConn };
}
