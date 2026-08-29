import {
  DEFAULT_VERSIONS,
  DOCKER_DEFAULT_VERSIONS,
  SERVICE_NAMES,
  dockerImageForArtifact,
  serviceMetadata,
} from "./ServiceCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";
import { Schema } from "effect";

export { DEFAULT_VERSIONS, DOCKER_DEFAULT_VERSIONS, SERVICE_NAMES } from "./ServiceCatalog.ts";
export type { ServiceName } from "./ServiceName.ts";

export type VersionRuntime = "native" | "docker";

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

export const defaultVersionsForRuntime = (
  runtime: VersionRuntime,
): Readonly<Record<ServiceName, string>> =>
  runtime === "docker" ? DOCKER_DEFAULT_VERSIONS : DEFAULT_VERSIONS;

/**
 * Returns the full Docker image URL for a service.
 */
export function dockerImageForService(service: ServiceName, version: string): string {
  return dockerImageForArtifact(service, normalizeServiceVersion(service, version, "docker"));
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
export function normalizeServiceVersion(
  service: ServiceName,
  version: string,
  runtime: VersionRuntime = "native",
): string {
  const normalized = version.trim();
  const metadata = serviceMetadata(service);
  const tagPrefix = metadata.artifact.docker.tagPrefix;
  const withoutDockerTagPrefix =
    tagPrefix !== undefined &&
    normalized.slice(0, tagPrefix.length).toLowerCase() === tagPrefix.toLowerCase()
      ? normalized.slice(tagPrefix.length)
      : normalized;
  // Explicit opaque identifiers (for example a commit label used by Studio)
  // are already canonical and must not acquire a semantic-version prefix.
  if (!/^[vV]?\d/.test(withoutDockerTagPrefix)) return withoutDockerTagPrefix;
  const defaultVersion = metadata.defaultVersions[runtime];
  if (!defaultVersion.startsWith("v")) {
    return withoutDockerTagPrefix.slice(0, 1).toLowerCase() === "v"
      ? withoutDockerTagPrefix.slice(1)
      : withoutDockerTagPrefix;
  }
  return withoutDockerTagPrefix.slice(0, 1).toLowerCase() === "v"
    ? `v${withoutDockerTagPrefix.slice(1)}`
    : `v${withoutDockerTagPrefix}`;
}

export function normalizeServiceVersions(
  versions: Partial<Record<ServiceName, string | undefined>>,
  runtime: VersionRuntime = "native",
): Partial<VersionManifest> {
  const normalized: Partial<Record<ServiceName, string>> = {};
  for (const service of SERVICE_NAMES) {
    const version = versions[service];
    if (typeof version === "string" && version.trim().length > 0) {
      normalized[service] = normalizeServiceVersion(service, version, runtime);
    }
  }
  return normalized;
}

export function fillServiceVersionManifest(
  versions: Partial<Record<ServiceName, string | undefined>>,
  runtime: VersionRuntime = "native",
): VersionManifest {
  const filled: Partial<Record<ServiceName, string>> = {};
  const defaults = defaultVersionsForRuntime(runtime);
  for (const service of SERVICE_NAMES) {
    filled[service] = versions[service] ?? defaults[service];
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
