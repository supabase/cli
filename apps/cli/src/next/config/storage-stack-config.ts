import {
  parseStorageSizeBytes,
  type ProjectConfig,
  type ProjectEnvironment,
} from "@supabase/config";
import type { StorageConfig } from "@supabase/stack/effect";
import {
  environmentOverride,
  invalidDataPlaneConfig,
  rawEnvironmentOverride,
  resolveBooleanOverride,
} from "./data-plane-stack-config-values.ts";

function resolveFileSizeLimit(input: {
  readonly configured: string;
  readonly environment: ProjectEnvironment | null;
}): string {
  const configured =
    environmentOverride("SUPABASE_STORAGE_FILE_SIZE_LIMIT", input.configured, input.environment) ??
    input.configured;
  try {
    return String(parseStorageSizeBytes(configured));
  } catch {
    throw invalidDataPlaneConfig(
      "storage.file_size_limit",
      "Use a byte count or size such as 50MiB.",
    );
  }
}

export function resolveStorageStackConfig(input: {
  readonly config: ProjectConfig["storage"];
  readonly environment: ProjectEnvironment | null;
  readonly base: StorageConfig | false | undefined;
}): StorageConfig | false {
  const fileSizeLimit = resolveFileSizeLimit({
    configured: input.config.file_size_limit,
    environment: input.environment,
  });
  const s3ProtocolEnabled = resolveBooleanOverride({
    environment: input.environment,
    envName: "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
    configured: input.config.s3_protocol.enabled,
    path: "storage.s3_protocol.enabled",
  });
  const vectorBucketsEnabled = resolveBooleanOverride({
    environment: input.environment,
    envName: "SUPABASE_STORAGE_VECTOR_ENABLED",
    configured: input.config.vector.enabled,
    path: "storage.vector.enabled",
  });
  const vectorRuntime = vectorBucketsEnabled
    ? {
        enabled: rawEnvironmentOverride("VECTOR_ENABLED", "true", input.environment) ?? "true",
        provider:
          rawEnvironmentOverride("VECTOR_BUCKET_PROVIDER", "pgvector", input.environment) ??
          "pgvector",
        migrationsEnabled:
          rawEnvironmentOverride("VECTOR_STORE_MIGRATIONS_ENABLED", "true", input.environment) ??
          "true",
        databaseUrl: rawEnvironmentOverride("VECTOR_DATABASE_URL", undefined, input.environment),
      }
    : undefined;

  return input.base === false
    ? false
    : {
        ...input.base,
        fileSizeLimit,
        s3ProtocolEnabled,
        vectorRuntime,
      };
}
