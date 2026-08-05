import type { ProjectConfig, ProjectEnvironment } from "@supabase/config";
import type { PoolerConfig } from "@supabase/stack/effect";
import { resolveEnumOverride, resolveUintOverride } from "./data-plane-stack-config-values.ts";

export function resolvePoolerStackConfig(input: {
  readonly config: ProjectConfig["db"]["pooler"];
  readonly environment: ProjectEnvironment | null;
  readonly base: PoolerConfig | false | undefined;
}): PoolerConfig | false {
  const mode = resolveEnumOverride<"transaction" | "session">({
    environment: input.environment,
    envName: "SUPABASE_DB_POOLER_POOL_MODE",
    configured: input.config.pool_mode,
    path: "db.pooler.pool_mode",
    values: ["transaction", "session"],
  });
  const defaultPoolSize = resolveUintOverride({
    environment: input.environment,
    envName: "SUPABASE_DB_POOLER_DEFAULT_POOL_SIZE",
    configured: input.config.default_pool_size,
    path: "db.pooler.default_pool_size",
  });
  const maxClientConn = resolveUintOverride({
    environment: input.environment,
    envName: "SUPABASE_DB_POOLER_MAX_CLIENT_CONN",
    configured: input.config.max_client_conn,
    path: "db.pooler.max_client_conn",
  });

  return input.base === false ? false : { ...input.base, mode, defaultPoolSize, maxClientConn };
}
