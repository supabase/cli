import { Schema } from "effect";
import { AllocatedPortsSchema, type AllocatedPorts } from "./PortAllocator.ts";
import type { ResolvedStackConfig } from "./StackBuilder.ts";
import { SERVICE_NAMES, type ServiceName, type VersionManifest } from "./versions.ts";

const VersionManifestSchema = Schema.Struct({
  postgres: Schema.String,
  postgrest: Schema.String,
  auth: Schema.String,
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

export const StackMetadataSchema = Schema.Struct({
  schemaVersion: Schema.Number,
  updatedAt: Schema.String,
  ports: AllocatedPortsSchema,
  services: VersionManifestSchema,
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
    const serviceConfig = config[service];
    if (serviceConfig !== false) {
      versions[service] = serviceConfig.version;
    }
  }

  return versions;
}

export function stackMetadata(args: {
  readonly ports: AllocatedPorts;
  readonly services: VersionManifest;
  readonly updatedAt?: string;
  readonly lastNotifiedUpdateFingerprint?: string;
}): StackMetadata {
  return {
    schemaVersion: STACK_METADATA_SCHEMA_VERSION,
    updatedAt: args.updatedAt ?? new Date().toISOString(),
    ports: args.ports,
    services: args.services,
    ...(args.lastNotifiedUpdateFingerprint === undefined
      ? {}
      : { lastNotifiedUpdateFingerprint: args.lastNotifiedUpdateFingerprint }),
  };
}
