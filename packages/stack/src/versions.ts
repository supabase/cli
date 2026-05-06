export type ServiceName =
  | "postgres"
  | "postgrest"
  | "auth"
  | "edge-runtime"
  | "realtime"
  | "storage"
  | "imgproxy"
  | "mailpit"
  | "pgmeta"
  | "studio"
  | "analytics"
  | "vector"
  | "pooler";

export const SERVICE_NAMES = [
  "postgres",
  "postgrest",
  "auth",
  "edge-runtime",
  "realtime",
  "storage",
  "imgproxy",
  "mailpit",
  "pgmeta",
  "studio",
  "analytics",
  "vector",
  "pooler",
] as const satisfies ReadonlyArray<ServiceName>;

export interface VersionManifest {
  readonly postgres: string;
  readonly postgrest: string;
  readonly auth: string;
  readonly "edge-runtime": string;
  readonly realtime: string;
  readonly storage: string;
  readonly imgproxy: string;
  readonly mailpit: string;
  readonly pgmeta: string;
  readonly studio: string;
  readonly analytics: string;
  readonly vector: string;
  readonly pooler: string;
}

export const DEFAULT_VERSIONS: VersionManifest = {
  postgres: "17.6.1.107",
  postgrest: "14.5",
  auth: "2.188.0-rc.15",
  "edge-runtime": "1.73.13",
  realtime: "2.78.10",
  storage: "1.41.8",
  imgproxy: "v3.8.0",
  mailpit: "v1.22.3",
  pgmeta: "0.96.1",
  studio: "2026.03.04-sha-0043607",
  analytics: "1.34.7",
  vector: "0.28.1-alpine",
  pooler: "2.7.4",
} as const;

/** Default registry. Matches the Go CLI default (`public.ecr.aws`). */
const DEFAULT_REGISTRY = "public.ecr.aws/supabase";
const DOCKER_HUB_SUPABASE_REGISTRY = "supabase";
const GHCR_SUPABASE_REGISTRY = "ghcr.io/supabase";

const IMAGE_REPOSITORIES: Record<ServiceName, string> = {
  postgres: "postgres",
  postgrest: "postgrest",
  auth: "gotrue",
  "edge-runtime": "edge-runtime",
  realtime: "realtime",
  storage: "storage-api",
  imgproxy: "darthsim/imgproxy",
  mailpit: "axllent/mailpit",
  pgmeta: "postgres-meta",
  studio: "studio",
  analytics: "logflare",
  vector: "timberio/vector",
  pooler: "supavisor",
};

const SUPABASE_REGISTRY_SERVICES = new Set<ServiceName>([
  "postgres",
  "postgrest",
  "auth",
  "edge-runtime",
  "realtime",
  "storage",
  "pgmeta",
  "studio",
  "analytics",
  "pooler",
]);

export const IMAGE_TAG_PREFIX: Partial<Record<ServiceName, string>> = {
  postgrest: "v",
  auth: "v",
  "edge-runtime": "v",
  realtime: "v",
  storage: "v",
  pgmeta: "v",
};

/**
 * Returns the full Docker image URL for a service.
 *
 * Uses the same registry resolution as the Go CLI: images are pulled from
 * `public.ecr.aws/supabase/` by default (faster than Docker Hub).
 */
export function dockerImageForService(service: ServiceName, version: string): string {
  const repository = IMAGE_REPOSITORIES[service];
  if (SUPABASE_REGISTRY_SERVICES.has(service)) {
    return `${DEFAULT_REGISTRY}/${repository}:${IMAGE_TAG_PREFIX[service] ?? ""}${version}`;
  }
  return `${repository}:${IMAGE_TAG_PREFIX[service] ?? ""}${version}`;
}

export function dockerImageCandidatesForService(
  service: ServiceName,
  version: string,
): ReadonlyArray<string> {
  const repository = IMAGE_REPOSITORIES[service];
  const tag = `${IMAGE_TAG_PREFIX[service] ?? ""}${version}`;
  if (!SUPABASE_REGISTRY_SERVICES.has(service)) {
    return [`${repository}:${tag}`];
  }
  return [
    `${DEFAULT_REGISTRY}/${repository}:${tag}`,
    `${DOCKER_HUB_SUPABASE_REGISTRY}/${repository}:${tag}`,
    `${GHCR_SUPABASE_REGISTRY}/${repository}:${tag}`,
  ];
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

/**
 * Normalizes a version string for a service based on its image tag prefix.
 *
 * Services with a "v" prefix in IMAGE_TAG_PREFIX (e.g. postgrest, auth) store
 * versions without the "v" prefix (it gets prepended at image-pull time).
 * Services without a prefix entry but whose DEFAULT_VERSIONS start with "v"
 * (e.g. imgproxy, mailpit) store versions with the "v" prefix.
 * All other services pass through trimmed.
 */
export function normalizeServiceVersion(service: ServiceName, version: string): string {
  const trimmed = version.trim();
  const prefix = IMAGE_TAG_PREFIX[service];

  if (prefix === "v") {
    return trimmed.replace(/^v/i, "");
  }

  if (prefix === undefined && DEFAULT_VERSIONS[service].startsWith("v")) {
    return /^v/i.test(trimmed) ? `v${trimmed.slice(1)}` : `v${trimmed}`;
  }

  return trimmed;
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
