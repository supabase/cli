import { Record } from "effect";
import {
  authAssetName,
  edgeRuntimeAssetName,
  postgresAssetName,
  postgrestAssetName,
  type PlatformInfo,
} from "./Platform.ts";
import type { PortField } from "./PortCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";

type ArtifactOwnership = "supabase" | "upstream";
type ServiceRuntimeSupport = "native-preferred" | "docker-only";
export type ArchiveFormat = "tar.gz" | "tar.xz" | "zip";

export interface NativeReleaseArtifact {
  readonly provider: string;
  readonly assetName: string;
  readonly archive: ArchiveFormat;
  readonly downloadUrl: string;
  readonly checksumUrl: string | null;
  readonly stripComponents: boolean;
}

interface NativeReleaseSource {
  readonly provider: string;
  readonly resolve: (version: string, platform: PlatformInfo) => NativeReleaseArtifact | undefined;
}

interface DockerImageSource {
  readonly ownership: ArtifactOwnership;
  readonly repository: string;
  readonly tagPrefix?: string;
}

interface ServiceArtifactDefinition {
  readonly docker: DockerImageSource;
  readonly native?: NativeReleaseSource;
}

interface ServiceActivationPolicy {
  /** Whether the public service must already be running when lazy startup completes. */
  readonly startup: "eager" | "lazy";
  /** Other public services required when this service is activated. */
  readonly activates: ReadonlyArray<ServiceName>;
  /** Private companions whose lifecycle is exclusively owned by this service. */
  readonly owns: ReadonlyArray<ServiceName>;
}

type ServiceConfigKey =
  | "postgres"
  | "postgrest"
  | "auth"
  | "edgeRuntime"
  | "realtime"
  | "storage"
  | "imgproxy"
  | "mailpit"
  | "pgmeta"
  | "studio"
  | "analytics"
  | "vector"
  | "pooler";

export interface ServiceCatalogEntry<Name extends ServiceName> {
  readonly name: Name;
  readonly configKey: ServiceConfigKey;
  readonly defaultVersion: string;
  readonly runtimeSupport: ServiceRuntimeSupport;
  readonly artifact: ServiceArtifactDefinition;
  readonly activation: ServiceActivationPolicy;
  readonly portFields: ReadonlyArray<PortField>;
}

const SUPABASE_ECR_REGISTRY = "public.ecr.aws/supabase";
const SUPABASE_DOCKER_HUB_REGISTRY = "supabase";
const SUPABASE_GHCR_REGISTRY = "ghcr.io/supabase";

const nativeRelease = (
  provider: string,
  assetName: string | null,
  archive: ArchiveFormat,
  downloadUrl: string,
  options?: {
    readonly checksumUrl?: string;
    readonly stripComponents?: boolean;
  },
): NativeReleaseArtifact | undefined =>
  assetName === null
    ? undefined
    : {
        provider,
        assetName,
        archive,
        downloadUrl,
        checksumUrl: options?.checksumUrl ?? null,
        stripComponents: options?.stripComponents ?? false,
      };

const authReleaseTag = (version: string): string =>
  version.includes("-rc.") ? `rc${version}` : `v${version}`;

/**
 * Exhaustive static identity and capability metadata for public stack services.
 * Cross-service topology and process definitions deliberately remain in StackBuilder.
 */
export const SERVICE_CATALOG = {
  postgres: {
    name: "postgres",
    configKey: "postgres",
    defaultVersion: "17.6.1.159",
    runtimeSupport: "native-preferred",
    artifact: {
      docker: { ownership: "supabase", repository: "postgres" },
      native: {
        provider: "github.com/supabase/postgres",
        resolve: (version, platform) => {
          const assetName = postgresAssetName(platform);
          const cliVersion = `${version}-cli`;
          const url = `https://github.com/supabase/postgres/releases/download/v${cliVersion}/supabase-postgres-v${cliVersion}-${assetName}.tar.gz`;
          return nativeRelease("github.com/supabase/postgres", assetName, "tar.gz", url, {
            checksumUrl: `${url}.sha256`,
            stripComponents: true,
          });
        },
      },
    },
    activation: { startup: "eager", activates: [], owns: [] },
    portFields: ["dbPort"],
  },
  postgrest: {
    name: "postgrest",
    configKey: "postgrest",
    defaultVersion: "16.1",
    runtimeSupport: "native-preferred",
    artifact: {
      docker: { ownership: "supabase", repository: "postgrest", tagPrefix: "v" },
      native: {
        provider: "github.com/PostgREST/postgrest",
        resolve: (version, platform) => {
          const assetName = postgrestAssetName(platform);
          const archive = assetName?.startsWith("windows") === true ? "zip" : "tar.xz";
          return nativeRelease(
            "github.com/PostgREST/postgrest",
            assetName,
            archive,
            `https://github.com/PostgREST/postgrest/releases/download/v${version}/postgrest-v${version}-${assetName}.${archive}`,
          );
        },
      },
    },
    activation: { startup: "lazy", activates: [], owns: [] },
    portFields: ["postgrestPort", "postgrestAdminPort"],
  },
  auth: {
    name: "auth",
    configKey: "auth",
    defaultVersion: "2.195.0",
    runtimeSupport: "native-preferred",
    artifact: {
      docker: { ownership: "supabase", repository: "gotrue", tagPrefix: "v" },
      native: {
        provider: "github.com/supabase/auth",
        resolve: (version, platform) => {
          const assetName = authAssetName(platform);
          return nativeRelease(
            "github.com/supabase/auth",
            assetName,
            "tar.gz",
            `https://github.com/supabase/auth/releases/download/${authReleaseTag(version)}/auth-v${version}-${assetName}.tar.gz`,
          );
        },
      },
    },
    activation: { startup: "lazy", activates: [], owns: [] },
    portFields: ["authPort"],
  },
  "edge-runtime": {
    name: "edge-runtime",
    configKey: "edgeRuntime",
    defaultVersion: "1.74.3",
    runtimeSupport: "docker-only",
    artifact: {
      docker: { ownership: "supabase", repository: "edge-runtime", tagPrefix: "v" },
      native: {
        provider: "github.com/supabase/edge-runtime",
        resolve: (version, platform) => {
          const assetName = edgeRuntimeAssetName(platform);
          return nativeRelease(
            "github.com/supabase/edge-runtime",
            assetName,
            "tar.gz",
            `https://github.com/supabase/edge-runtime/releases/download/v${version}/edge-runtime-v${version}-${assetName}.tar.gz`,
          );
        },
      },
    },
    activation: { startup: "lazy", activates: [], owns: [] },
    portFields: ["edgeRuntimePort", "edgeRuntimeInspectorPort"],
  },
  realtime: {
    name: "realtime",
    configKey: "realtime",
    defaultVersion: "2.129.0",
    runtimeSupport: "docker-only",
    artifact: { docker: { ownership: "supabase", repository: "realtime", tagPrefix: "v" } },
    activation: { startup: "eager", activates: [], owns: [] },
    portFields: ["realtimePort"],
  },
  storage: {
    name: "storage",
    configKey: "storage",
    defaultVersion: "1.69.11",
    runtimeSupport: "docker-only",
    artifact: { docker: { ownership: "supabase", repository: "storage-api", tagPrefix: "v" } },
    activation: { startup: "lazy", activates: ["imgproxy"], owns: ["imgproxy"] },
    portFields: ["storagePort"],
  },
  imgproxy: {
    name: "imgproxy",
    configKey: "imgproxy",
    defaultVersion: "v3.8.0",
    runtimeSupport: "docker-only",
    artifact: { docker: { ownership: "upstream", repository: "darthsim/imgproxy" } },
    activation: { startup: "lazy", activates: [], owns: [] },
    portFields: ["imgproxyPort"],
  },
  mailpit: {
    name: "mailpit",
    configKey: "mailpit",
    defaultVersion: "v1.30.2",
    runtimeSupport: "docker-only",
    artifact: { docker: { ownership: "upstream", repository: "axllent/mailpit" } },
    activation: { startup: "eager", activates: [], owns: [] },
    portFields: ["mailpitPort", "mailpitSmtpPort", "mailpitPop3Port"],
  },
  pgmeta: {
    name: "pgmeta",
    configKey: "pgmeta",
    defaultVersion: "0.98.0",
    runtimeSupport: "docker-only",
    artifact: {
      docker: { ownership: "supabase", repository: "postgres-meta", tagPrefix: "v" },
    },
    activation: { startup: "lazy", activates: [], owns: [] },
    portFields: ["pgmetaPort"],
  },
  studio: {
    name: "studio",
    configKey: "studio",
    defaultVersion: "2026.08.17-sha-0c1da8f",
    runtimeSupport: "docker-only",
    artifact: { docker: { ownership: "supabase", repository: "studio" } },
    activation: { startup: "eager", activates: ["analytics"], owns: [] },
    portFields: ["studioPort"],
  },
  analytics: {
    name: "analytics",
    configKey: "analytics",
    defaultVersion: "1.50.2",
    runtimeSupport: "docker-only",
    artifact: { docker: { ownership: "supabase", repository: "logflare" } },
    activation: { startup: "lazy", activates: ["vector"], owns: ["vector"] },
    portFields: ["analyticsPort"],
  },
  vector: {
    name: "vector",
    configKey: "vector",
    defaultVersion: "0.53.0-alpine",
    runtimeSupport: "docker-only",
    artifact: { docker: { ownership: "upstream", repository: "timberio/vector" } },
    activation: { startup: "lazy", activates: [], owns: [] },
    portFields: [],
  },
  pooler: {
    name: "pooler",
    configKey: "pooler",
    defaultVersion: "2.9.7",
    runtimeSupport: "docker-only",
    artifact: { docker: { ownership: "supabase", repository: "supavisor" } },
    activation: { startup: "eager", activates: [], owns: [] },
    portFields: ["poolerPort", "poolerApiPort"],
  },
} satisfies { readonly [Name in ServiceName]: ServiceCatalogEntry<Name> };

export const SERVICE_NAMES: ReadonlyArray<ServiceName> = Record.keys(SERVICE_CATALOG);

export const DEFAULT_VERSIONS: Readonly<Record<ServiceName, string>> = Record.map(
  SERVICE_CATALOG,
  (metadata) => metadata.defaultVersion,
);

export const serviceMetadata = (service: ServiceName): ServiceCatalogEntry<ServiceName> =>
  SERVICE_CATALOG[service];

export const nativeReleaseForService = (
  service: ServiceName,
  version: string,
  platform: PlatformInfo,
): NativeReleaseArtifact | undefined =>
  serviceMetadata(service).artifact.native?.resolve(version, platform);

export const isDockerOnlyService = (service: ServiceName): boolean =>
  SERVICE_CATALOG[service].runtimeSupport === "docker-only";

const dockerTag = (service: ServiceName, version: string): string => {
  const source = serviceMetadata(service).artifact.docker;
  return `${source.tagPrefix ?? ""}${version}`;
};

export const dockerImageForArtifact = (service: ServiceName, version: string): string => {
  const source = SERVICE_CATALOG[service].artifact.docker;
  const repository =
    source.ownership === "supabase"
      ? `${SUPABASE_ECR_REGISTRY}/${source.repository}`
      : source.repository;
  return `${repository}:${dockerTag(service, version)}`;
};

export const dockerImageCandidatesForArtifact = (
  service: ServiceName,
  version: string,
): ReadonlyArray<string> => {
  const source = SERVICE_CATALOG[service].artifact.docker;
  const tag = dockerTag(service, version);
  if (source.ownership === "upstream") {
    return [`${source.repository}:${tag}`];
  }
  return [
    `${SUPABASE_ECR_REGISTRY}/${source.repository}:${tag}`,
    `${SUPABASE_DOCKER_HUB_REGISTRY}/${source.repository}:${tag}`,
    `${SUPABASE_GHCR_REGISTRY}/${source.repository}:${tag}`,
  ];
};

export const imageTagPrefixForService = (service: ServiceName): string | undefined =>
  serviceMetadata(service).artifact.docker.tagPrefix;
