import {
  DEFAULT_VERSIONS,
  SERVICE_NAMES,
  dockerImageForArtifact,
  serviceMetadata,
} from "./ServiceCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";
import { Schema } from "effect";

export { DEFAULT_VERSIONS, SERVICE_NAMES } from "./ServiceCatalog.ts";
export type { ServiceName } from "./ServiceName.ts";

export type VersionManifest = Readonly<Record<ServiceName, string>>;

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

/**
 * Returns the full Docker image URL for a service.
 */
export function dockerImageForService(service: ServiceName, version: string): string {
  return dockerImageForArtifact(service, version);
}

function assertFullVersions(
  versions: Partial<Record<ServiceName, string | undefined>>,
): asserts versions is Record<ServiceName, string> {
  const missing = SERVICE_NAMES.filter((service) => versions[service] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing service versions for: ${missing.join(", ")}`);
  }
}

export function fullVersionManifest(
  versions: Partial<Record<ServiceName, string | undefined>>,
): VersionManifest {
  assertFullVersions(versions);
  return versions;
}

/** Normalizes a version string to the catalog's canonical stored form. */
export function normalizeServiceVersion(service: ServiceName, version: string): string {
  const normalized = version.trim();
  const tagPrefix = serviceMetadata(service).artifact.docker.tagPrefix;
  return tagPrefix !== undefined && normalized.startsWith(tagPrefix)
    ? normalized.slice(tagPrefix.length)
    : normalized;
}

export function normalizeServiceVersions(
  versions: Partial<Record<ServiceName, string | undefined>>,
): Partial<VersionManifest> {
  const normalized: Partial<Record<ServiceName, string>> = {};
  for (const service of SERVICE_NAMES) {
    const version = versions[service];
    if (typeof version === "string" && version.trim().length > 0) {
      normalized[service] = normalizeServiceVersion(service, version);
    }
  }
  return normalized;
}

export function fillServiceVersionManifest(
  versions: Partial<Record<ServiceName, string | undefined>>,
): VersionManifest {
  const filled: Partial<Record<ServiceName, string>> = {};
  for (const service of SERVICE_NAMES) {
    filled[service] = versions[service] ?? DEFAULT_VERSIONS[service];
  }
  return fullVersionManifest(filled);
}

export interface AvailableServiceVersionUpdate {
  readonly service: ServiceName;
  readonly pinnedVersion: string;
  readonly availableVersion: string;
}

export function diffPinnedAndAvailableVersions(
  pinnedBaseline: VersionManifest,
  candidateBaseline: VersionManifest,
): ReadonlyArray<AvailableServiceVersionUpdate> {
  return SERVICE_NAMES.flatMap((service) => {
    const pinnedVersion = pinnedBaseline[service];
    const availableVersion = candidateBaseline[service];
    if (pinnedVersion === availableVersion) {
      return [];
    }
    return [{ service, pinnedVersion, availableVersion }];
  });
}
