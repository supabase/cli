import {
  authAssetName,
  edgeRuntimeAssetName,
  postgresAssetName,
  postgrestAssetName,
  type PlatformInfo,
} from "./Platform.ts";
import type { ServiceName } from "./versions.ts";

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

export interface ServiceArtifactDefinition {
  readonly runtimeSupport: ServiceRuntimeSupport;
  readonly docker: DockerImageSource;
  readonly native?: NativeReleaseSource;
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

export const SERVICE_ARTIFACTS: Record<ServiceName, ServiceArtifactDefinition> = {
  postgres: {
    runtimeSupport: "native-preferred",
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
  postgrest: {
    runtimeSupport: "native-preferred",
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
  auth: {
    runtimeSupport: "native-preferred",
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
  "edge-runtime": {
    runtimeSupport: "docker-only",
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
  realtime: {
    runtimeSupport: "docker-only",
    docker: { ownership: "supabase", repository: "realtime", tagPrefix: "v" },
  },
  storage: {
    runtimeSupport: "docker-only",
    docker: { ownership: "supabase", repository: "storage-api", tagPrefix: "v" },
  },
  imgproxy: {
    runtimeSupport: "docker-only",
    docker: { ownership: "upstream", repository: "ghcr.io/imgproxy/imgproxy" },
  },
  mailpit: {
    runtimeSupport: "docker-only",
    docker: { ownership: "upstream", repository: "axllent/mailpit" },
  },
  pgmeta: {
    runtimeSupport: "docker-only",
    docker: { ownership: "supabase", repository: "postgres-meta", tagPrefix: "v" },
  },
  studio: {
    runtimeSupport: "docker-only",
    docker: { ownership: "supabase", repository: "studio" },
  },
  analytics: {
    runtimeSupport: "docker-only",
    docker: { ownership: "supabase", repository: "logflare" },
  },
  vector: {
    runtimeSupport: "docker-only",
    docker: { ownership: "upstream", repository: "timberio/vector" },
  },
  pooler: {
    runtimeSupport: "docker-only",
    docker: { ownership: "supabase", repository: "supavisor" },
  },
};

export const nativeReleaseForService = (
  service: ServiceName,
  version: string,
  platform: PlatformInfo,
): NativeReleaseArtifact | undefined =>
  SERVICE_ARTIFACTS[service].native?.resolve(version, platform);

export const isDockerOnlyService = (service: ServiceName): boolean =>
  SERVICE_ARTIFACTS[service].runtimeSupport === "docker-only";

const dockerTag = (service: ServiceName, version: string): string => {
  const source = SERVICE_ARTIFACTS[service].docker;
  return `${source.tagPrefix ?? ""}${version}`;
};

export const dockerImageForArtifact = (service: ServiceName, version: string): string => {
  const source = SERVICE_ARTIFACTS[service].docker;
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
  const source = SERVICE_ARTIFACTS[service].docker;
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
  SERVICE_ARTIFACTS[service].docker.tagPrefix;
