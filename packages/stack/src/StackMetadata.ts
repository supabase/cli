import { Schema } from "effect";
import { CleanupTargetsSchema, type CleanupTargets } from "./CleanupTargets.ts";
import { AllocatedPortsSchema, type AllocatedPorts } from "./PortAllocator.ts";
import type { ResolvedStackConfig } from "./StackBuilder.ts";
import { SERVICE_NAMES, type ServiceName, type VersionManifest } from "./versions.ts";

const VersionManifestSchema = Schema.Struct({
  postgres: Schema.String,
  postgrest: Schema.String,
  auth: Schema.String,
  "edge-runtime": Schema.String,
  realtime: Schema.String,
  storage: Schema.String,
  imgproxy: Schema.String,
  mailpit: Schema.String,
  pgmeta: Schema.String,
  studio: Schema.String,
  analytics: Schema.String,
  vector: Schema.String,
  pooler: Schema.String,
});

export const PartialVersionManifestSchema = Schema.Struct({
  postgres: Schema.optionalKey(Schema.String),
  postgrest: Schema.optionalKey(Schema.String),
  auth: Schema.optionalKey(Schema.String),
  "edge-runtime": Schema.optionalKey(Schema.String),
  realtime: Schema.optionalKey(Schema.String),
  storage: Schema.optionalKey(Schema.String),
  imgproxy: Schema.optionalKey(Schema.String),
  mailpit: Schema.optionalKey(Schema.String),
  pgmeta: Schema.optionalKey(Schema.String),
  studio: Schema.optionalKey(Schema.String),
  analytics: Schema.optionalKey(Schema.String),
  vector: Schema.optionalKey(Schema.String),
  pooler: Schema.optionalKey(Schema.String),
});

export type PartialVersionManifest = Schema.Schema.Type<typeof PartialVersionManifestSchema>;

const StackLaunchSchema = Schema.Struct({
  mode: Schema.Literals(["native", "auto", "docker"] as const),
  excludedServices: Schema.Array(
    Schema.Literals([
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
    ] as const),
  ),
});

type StackLaunch = Schema.Schema.Type<typeof StackLaunchSchema>;

export const StackMetadataSchema = Schema.Struct({
  schemaVersion: Schema.Number,
  updatedAt: Schema.String,
  ports: AllocatedPortsSchema,
  services: VersionManifestSchema,
  launch: Schema.optionalKey(StackLaunchSchema),
  cleanupTargets: Schema.optionalKey(CleanupTargetsSchema),
  lastNotifiedUpdateFingerprint: Schema.optionalKey(Schema.String),
});

export type StackMetadata = Schema.Schema.Type<typeof StackMetadataSchema>;

export const STACK_METADATA_SCHEMA_VERSION = 1;

export function runningServiceVersionsForConfig(
  config: ResolvedStackConfig,
): PartialVersionManifest {
  const versions: Partial<Record<ServiceName, string>> = {
    postgres: config.postgres.version,
  };

  for (const service of SERVICE_NAMES) {
    if (service === "postgres") {
      continue;
    }
    const serviceConfig = service === "edge-runtime" ? config.edgeRuntime : config[service];
    if (serviceConfig !== false) {
      versions[service] = serviceConfig.version;
    }
  }

  return versions;
}

export function stackMetadata(args: {
  readonly ports: AllocatedPorts;
  readonly services: VersionManifest;
  readonly launch: StackLaunch;
  readonly cleanupTargets?: CleanupTargets;
  readonly updatedAt?: string;
  readonly lastNotifiedUpdateFingerprint?: string;
}): StackMetadata {
  return {
    schemaVersion: STACK_METADATA_SCHEMA_VERSION,
    updatedAt: args.updatedAt ?? new Date().toISOString(),
    ports: args.ports,
    services: args.services,
    launch: args.launch,
    ...(args.cleanupTargets === undefined ? {} : { cleanupTargets: args.cleanupTargets }),
    ...(args.lastNotifiedUpdateFingerprint === undefined
      ? {}
      : { lastNotifiedUpdateFingerprint: args.lastNotifiedUpdateFingerprint }),
  };
}
