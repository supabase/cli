import { Record } from "effect";
import { nativeTargetForPlatform, type NativeTarget, type PlatformInfo } from "./Platform.ts";
import type { PortField } from "./PortCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";

type ServiceRuntimeSupport = "native-preferred" | "docker-only";
type ArchiveFormat = "tar.zst";
export type ServicePreparationPolicy = "off" | "lazy" | "eager";

export interface NativeReleaseArtifact {
  readonly service: ServiceName;
  readonly version: string;
  readonly provider: string;
  readonly assetName: string;
  readonly releaseTag: string;
  readonly target: NativeTarget;
  readonly archive: ArchiveFormat;
  readonly downloadUrl: string;
  readonly manifestUrl: string;
  readonly checksumUrl: string;
  readonly requiredRuntimePaths: ReadonlyArray<string>;
}

interface NativeReleaseSource {
  readonly provider: string;
  readonly resolve: (version: string, platform: PlatformInfo) => NativeReleaseArtifact | undefined;
}

interface DockerImageSource {
  readonly repository: string;
  readonly tagPrefix?: string;
}

interface ServiceArtifactDefinition {
  readonly docker: DockerImageSource;
  readonly native?: NativeReleaseSource;
}

interface ServiceActivationPolicy {
  /** Other public services required when this service is activated. */
  readonly activates: ReadonlyArray<ServiceName>;
  /** Private companions whose lifecycle is exclusively owned by this service. */
  readonly owns: ReadonlyArray<ServiceName>;
}

export interface ServicePreparationMetadata {
  /** Policies supported by the service's runtime/resource implementation. */
  readonly supported: ReadonlyArray<Exclude<ServicePreparationPolicy, "off">>;
  readonly default: Exclude<ServicePreparationPolicy, "off">;
  /** Services whose resources must be materialized before this service can start. */
  readonly dependencies: ReadonlyArray<ServiceName>;
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
  readonly preparation: ServicePreparationMetadata;
  readonly portFields: ReadonlyArray<PortField>;
}

const SUPABASE_GHCR_REGISTRY = "ghcr.io/supabase/cli";
const SLIM_RELEASE_BASE = "https://github.com/supabase/slim-services/releases/download";

const nativeRelease = (
  service: ServiceName,
  version: string,
  platform: PlatformInfo,
  options: {
    readonly requiredRuntimePaths: ReadonlyArray<string>;
  },
): NativeReleaseArtifact | undefined => {
  const target = nativeTargetForPlatform(platform);
  if (target === undefined) return undefined;
  const releaseTag = `${service}-${version}`;
  const base = `${SLIM_RELEASE_BASE}/${releaseTag}`;
  const assetName = `${releaseTag}-${target}`;
  return {
    service,
    version,
    provider: "github.com/supabase/slim-services",
    assetName,
    releaseTag,
    target,
    archive: "tar.zst",
    downloadUrl: `${base}/${assetName}.tar.zst`,
    manifestUrl: `${base}/${assetName}.manifest.json`,
    checksumUrl: `${base}/SHA256SUMS`,
    requiredRuntimePaths: options.requiredRuntimePaths,
  };
};

const preparation = (
  supported: ReadonlyArray<Exclude<ServicePreparationPolicy, "off">>,
  defaultPolicy: Exclude<ServicePreparationPolicy, "off">,
  dependencies: ReadonlyArray<ServiceName> = [],
): ServicePreparationMetadata => ({
  supported,
  default: defaultPolicy,
  dependencies,
});

const genericNativeRelease = (service: ServiceName) => ({
  provider: "github.com/supabase/slim-services",
  resolve: (version: string, platform: PlatformInfo) =>
    nativeRelease(service, version, platform, {
      // These services are prepared generically before native process wiring
      // exists. Their manifest-declared paths are authoritative; do not guess
      // a consumer path that could make a valid archive fail installation.
      requiredRuntimePaths: [],
    }),
});

/**
 * Exhaustive static identity and capability metadata for public stack services.
 * Cross-service topology and process definitions deliberately remain in StackBuilder.
 */
export const SERVICE_CATALOG = {
  postgres: {
    name: "postgres",
    configKey: "postgres",
    defaultVersion: "17.6.1.163",
    runtimeSupport: "native-preferred",
    artifact: {
      docker: { repository: "postgres" },
      native: {
        provider: "github.com/supabase/slim-services",
        resolve: (version, platform) =>
          nativeRelease("postgres", version, platform, {
            requiredRuntimePaths: [
              "bin/postgres",
              "bin/pg_isready",
              "bin/psql",
              "share/supabase-cli/bin/supabase-postgres-init.sh",
              "lib",
            ],
          }),
      },
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["eager"], "eager"),
    portFields: ["dbPort"],
  },
  postgrest: {
    name: "postgrest",
    configKey: "postgrest",
    defaultVersion: "v16.1",
    runtimeSupport: "native-preferred",
    artifact: {
      docker: { repository: "postgrest" },
      native: {
        provider: "github.com/supabase/slim-services",
        resolve: (version, platform) =>
          nativeRelease("postgrest", version, platform, {
            requiredRuntimePaths: ["bin/postgrest"],
          }),
      },
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["lazy", "eager"], "lazy", ["postgres"]),
    portFields: ["postgrestPort", "postgrestAdminPort"],
  },
  auth: {
    name: "auth",
    configKey: "auth",
    defaultVersion: "v2.195.0",
    runtimeSupport: "native-preferred",
    artifact: {
      docker: { repository: "auth" },
      native: {
        provider: "github.com/supabase/slim-services",
        resolve: (version, platform) =>
          nativeRelease("auth", version, platform, {
            requiredRuntimePaths: ["bin/auth"],
          }),
      },
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["lazy", "eager"], "lazy", ["postgres"]),
    portFields: ["authPort"],
  },
  "edge-runtime": {
    name: "edge-runtime",
    configKey: "edgeRuntime",
    defaultVersion: "v1.74.3",
    runtimeSupport: "docker-only",
    artifact: {
      docker: { repository: "edge-runtime" },
      native: genericNativeRelease("edge-runtime"),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["lazy", "eager"], "lazy", ["postgres"]),
    portFields: ["edgeRuntimePort", "edgeRuntimeInspectorPort"],
  },
  realtime: {
    name: "realtime",
    configKey: "realtime",
    defaultVersion: "v2.129.1",
    runtimeSupport: "docker-only",
    artifact: {
      docker: { repository: "realtime" },
      native: genericNativeRelease("realtime"),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["eager"], "eager", ["postgres"]),
    portFields: ["realtimePort"],
  },
  storage: {
    name: "storage",
    configKey: "storage",
    defaultVersion: "v1.70.1",
    runtimeSupport: "docker-only",
    artifact: {
      docker: { repository: "storage" },
      native: genericNativeRelease("storage"),
    },
    activation: { activates: ["imgproxy"], owns: ["imgproxy"] },
    preparation: preparation(["lazy", "eager"], "lazy", ["postgres"]),
    portFields: ["storagePort"],
  },
  imgproxy: {
    name: "imgproxy",
    configKey: "imgproxy",
    defaultVersion: "v3.8.0",
    runtimeSupport: "docker-only",
    artifact: {
      docker: { repository: "imgproxy" },
      native: genericNativeRelease("imgproxy"),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["lazy", "eager"], "lazy", ["storage"]),
    portFields: ["imgproxyPort"],
  },
  mailpit: {
    name: "mailpit",
    configKey: "mailpit",
    defaultVersion: "v1.30.2",
    runtimeSupport: "docker-only",
    artifact: {
      docker: { repository: "mailpit" },
      native: genericNativeRelease("mailpit"),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["eager"], "eager"),
    portFields: ["mailpitPort", "mailpitSmtpPort", "mailpitPop3Port"],
  },
  pgmeta: {
    name: "pgmeta",
    configKey: "pgmeta",
    defaultVersion: "0.98.0",
    runtimeSupport: "docker-only",
    artifact: {
      docker: { repository: "pgmeta", tagPrefix: "v" },
      native: genericNativeRelease("pgmeta"),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["lazy", "eager"], "lazy", ["postgres"]),
    portFields: ["pgmetaPort"],
  },
  studio: {
    name: "studio",
    configKey: "studio",
    defaultVersion: "2026.08.17-sha-0c1da8f",
    runtimeSupport: "docker-only",
    artifact: {
      docker: { repository: "studio" },
      native: genericNativeRelease("studio"),
    },
    activation: { activates: ["analytics"], owns: [] },
    preparation: preparation(["eager"], "eager", ["pgmeta", "analytics"]),
    portFields: ["studioPort"],
  },
  analytics: {
    name: "analytics",
    configKey: "analytics",
    defaultVersion: "v1.50.3",
    runtimeSupport: "docker-only",
    artifact: {
      docker: { repository: "analytics" },
      native: genericNativeRelease("analytics"),
    },
    activation: { activates: ["vector"], owns: ["vector"] },
    preparation: preparation(["lazy", "eager"], "lazy", ["postgres"]),
    portFields: ["analyticsPort"],
  },
  vector: {
    name: "vector",
    configKey: "vector",
    defaultVersion: "0.53.0",
    runtimeSupport: "docker-only",
    artifact: {
      docker: { repository: "vector" },
      native: genericNativeRelease("vector"),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["lazy", "eager"], "lazy", ["analytics"]),
    portFields: [],
  },
  pooler: {
    name: "pooler",
    configKey: "pooler",
    defaultVersion: "v2.9.10",
    runtimeSupport: "docker-only",
    artifact: {
      docker: { repository: "pooler" },
      native: genericNativeRelease("pooler"),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["eager"], "eager", ["postgres"]),
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

export const DEFAULT_SERVICE_POLICIES: Readonly<
  Record<ServiceName, Exclude<ServicePreparationPolicy, "off">>
> = {
  postgres: SERVICE_CATALOG.postgres.preparation.default,
  postgrest: SERVICE_CATALOG.postgrest.preparation.default,
  auth: SERVICE_CATALOG.auth.preparation.default,
  "edge-runtime": SERVICE_CATALOG["edge-runtime"].preparation.default,
  realtime: SERVICE_CATALOG.realtime.preparation.default,
  storage: SERVICE_CATALOG.storage.preparation.default,
  imgproxy: SERVICE_CATALOG.imgproxy.preparation.default,
  mailpit: SERVICE_CATALOG.mailpit.preparation.default,
  pgmeta: SERVICE_CATALOG.pgmeta.preparation.default,
  studio: SERVICE_CATALOG.studio.preparation.default,
  analytics: SERVICE_CATALOG.analytics.preparation.default,
  vector: SERVICE_CATALOG.vector.preparation.default,
  pooler: SERVICE_CATALOG.pooler.preparation.default,
};

export const requiredPreparationDependencies = (service: ServiceName): ReadonlyArray<ServiceName> =>
  serviceMetadata(service).preparation.dependencies;

export const dockerImageForArtifact = (service: ServiceName, version: string): string => {
  const source = serviceMetadata(service).artifact.docker;
  return `${SUPABASE_GHCR_REGISTRY}/${source.repository}:${source.tagPrefix ?? ""}${version}`;
};
