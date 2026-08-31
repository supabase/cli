import { Record } from "effect";
import { nativeTargetForPlatform, type NativeTarget, type PlatformInfo } from "./Platform.ts";
import type { PortField } from "./PortCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";

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
  readonly registry?: string;
  readonly repository: string;
  readonly tagPrefix?: string;
}

interface ServiceArtifactDefinition {
  readonly docker: DockerImageSource;
  readonly native: NativeReleaseSource;
}

interface ServiceVersionDefaults {
  readonly native: string;
  readonly docker: string;
}

interface ServiceActivationPolicy {
  /** Other public services required when this service is activated. */
  readonly activates: ReadonlyArray<ServiceName>;
  /** Private companions whose lifecycle is exclusively owned by this service. */
  readonly owns: ReadonlyArray<ServiceName>;
}

interface ServicePreparationMetadata {
  /** Policies supported by the service's runtime/resource implementation. */
  readonly supported: ReadonlyArray<Exclude<ServicePreparationPolicy, "off">>;
  readonly default: Exclude<ServicePreparationPolicy, "off">;
  /** Services whose resources must be materialized before this service can start. */
  readonly dependencies: ReadonlyArray<ServiceName>;
}

interface ServiceConfigKeyByService {
  readonly postgres: "postgres";
  readonly postgrest: "postgrest";
  readonly auth: "auth";
  readonly "edge-runtime": "edgeRuntime";
  readonly realtime: "realtime";
  readonly storage: "storage";
  readonly imgproxy: "imgproxy";
  readonly mailpit: "mailpit";
  readonly pgmeta: "pgmeta";
  readonly studio: "studio";
  readonly analytics: "analytics";
  readonly vector: "vector";
  readonly pooler: "pooler";
}

export type ServiceConfigKey<Name extends ServiceName> = ServiceConfigKeyByService[Name];

export interface ServiceCatalogEntry<Name extends ServiceName> {
  readonly name: Name;
  readonly configKey: ServiceConfigKey<Name>;
  readonly defaultVersions: ServiceVersionDefaults;
  readonly artifact: ServiceArtifactDefinition;
  readonly activation: ServiceActivationPolicy;
  readonly preparation: ServicePreparationMetadata;
  readonly portFields: ReadonlyArray<PortField>;
}

const SUPABASE_GHCR_REGISTRY = "ghcr.io/supabase";
const SUPABASE_CLI_GHCR_REGISTRY = `${SUPABASE_GHCR_REGISTRY}/cli`;
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

const nativeSource = (
  service: ServiceName,
  requiredRuntimePaths: ReadonlyArray<string>,
): NativeReleaseSource => ({
  provider: "github.com/supabase/slim-services",
  resolve: (version, platform) =>
    nativeRelease(service, version, platform, { requiredRuntimePaths }),
});

const preparation = (
  supported: ReadonlyArray<Exclude<ServicePreparationPolicy, "off">>,
  defaultPolicy: Exclude<ServicePreparationPolicy, "off">,
  dependencies: ReadonlyArray<ServiceName> = [],
): ServicePreparationMetadata => ({
  supported,
  default: defaultPolicy,
  dependencies,
});

/**
 * Exhaustive static identity and capability metadata for public stack services.
 * Cross-service topology and process definitions deliberately remain in StackBuilder.
 */
export const SERVICE_CATALOG: {
  readonly [Name in ServiceName]: ServiceCatalogEntry<Name>;
} = {
  postgres: {
    name: "postgres",
    configKey: "postgres",
    defaultVersions: { native: "17.6.1.165", docker: "17.6.1.165" },
    artifact: {
      docker: { repository: "postgres" },
      native: nativeSource("postgres", [
        "bin/postgres",
        "bin/pg_isready",
        "bin/psql",
        "share/supabase-cli/bin/supabase-postgres-init.sh",
        "share/supabase-cli/config/pgsodium_getkey.sh",
        "share/supabase-cli/migrations",
        "lib",
      ]),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["eager"], "eager"),
    portFields: ["dbPort"],
  },
  postgrest: {
    name: "postgrest",
    configKey: "postgrest",
    defaultVersions: { native: "v16.2", docker: "v16.2" },
    artifact: {
      docker: { repository: "postgrest" },
      native: nativeSource("postgrest", ["bin/postgrest"]),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["lazy", "eager"], "lazy", ["postgres"]),
    portFields: ["postgrestPort", "postgrestAdminPort"],
  },
  auth: {
    name: "auth",
    configKey: "auth",
    defaultVersions: { native: "v2.196.0", docker: "v2.196.0" },
    artifact: {
      docker: { repository: "auth" },
      native: nativeSource("auth", ["bin/auth"]),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["lazy", "eager"], "lazy", ["postgres"]),
    portFields: ["authPort"],
  },
  "edge-runtime": {
    name: "edge-runtime",
    configKey: "edgeRuntime",
    defaultVersions: { native: "v1.74.3", docker: "v1.74.3" },
    artifact: {
      docker: { repository: "edge-runtime" },
      native: nativeSource("edge-runtime", ["bin/.edge-runtime-wrapped"]),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["lazy", "eager"], "lazy", ["postgres"]),
    portFields: ["edgeRuntimePort", "edgeRuntimeInspectorPort"],
  },
  realtime: {
    name: "realtime",
    configKey: "realtime",
    defaultVersions: { native: "v2.129.1", docker: "v2.129.9" },
    artifact: {
      docker: { repository: "realtime" },
      native: nativeSource("realtime", ["bin/migrate", "bin/realtime", "bin/server"]),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["lazy", "eager"], "eager", ["postgres"]),
    portFields: ["realtimePort"],
  },
  storage: {
    name: "storage",
    configKey: "storage",
    defaultVersions: { native: "v1.70.1", docker: "v1.71.0" },
    artifact: {
      docker: { repository: "storage" },
      native: nativeSource("storage", ["bin/storage"]),
    },
    activation: { activates: ["imgproxy"], owns: ["imgproxy"] },
    preparation: preparation(["lazy", "eager"], "lazy", ["postgres", "imgproxy"]),
    portFields: ["storagePort"],
  },
  imgproxy: {
    name: "imgproxy",
    configKey: "imgproxy",
    defaultVersions: { native: "v3.8.0", docker: "v3.8.0" },
    artifact: {
      docker: { repository: "imgproxy" },
      native: nativeSource("imgproxy", ["bin/imgproxy"]),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["lazy", "eager"], "lazy", ["storage"]),
    portFields: ["imgproxyPort"],
  },
  mailpit: {
    name: "mailpit",
    configKey: "mailpit",
    defaultVersions: { native: "v1.30.2", docker: "v1.30.2" },
    artifact: {
      docker: { repository: "mailpit" },
      native: nativeSource("mailpit", ["bin/mailpit"]),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["eager"], "eager"),
    portFields: ["mailpitPort", "mailpitSmtpPort", "mailpitPop3Port"],
  },
  pgmeta: {
    name: "pgmeta",
    configKey: "pgmeta",
    defaultVersions: { native: "v0.98.0", docker: "v0.98.0" },
    artifact: {
      docker: { repository: "pgmeta" },
      native: nativeSource("pgmeta", ["bin/pgmeta"]),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["lazy", "eager"], "lazy", ["postgres"]),
    portFields: ["pgmetaPort"],
  },
  studio: {
    name: "studio",
    configKey: "studio",
    defaultVersions: {
      native: "2026.08.17-sha-0c1da8f",
      docker: "2026.08.24-sha-8ec45b2",
    },
    artifact: {
      docker: { repository: "studio" },
      native: nativeSource("studio", ["bin/studio"]),
    },
    activation: { activates: ["analytics"], owns: [] },
    preparation: preparation(["eager"], "eager", ["pgmeta", "analytics"]),
    portFields: ["studioPort"],
  },
  analytics: {
    name: "analytics",
    configKey: "analytics",
    defaultVersions: { native: "v1.50.3", docker: "v1.50.6" },
    artifact: {
      docker: { repository: "analytics" },
      native: nativeSource("analytics", ["bin/logflare"]),
    },
    activation: { activates: ["vector"], owns: ["vector"] },
    preparation: preparation(["lazy", "eager"], "lazy", ["postgres", "vector"]),
    portFields: ["analyticsPort"],
  },
  vector: {
    name: "vector",
    configKey: "vector",
    defaultVersions: { native: "0.53.0", docker: "0.53.0-alpine" },
    artifact: {
      docker: { registry: SUPABASE_GHCR_REGISTRY, repository: "vector" },
      native: nativeSource("vector", ["bin/vector"]),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["lazy", "eager"], "lazy", ["analytics"]),
    // Vector's admin/health listener is private and only exists for native
    // processes. ServicePorts filters this field out for Docker allocations.
    portFields: ["vectorAdminPort"],
  },
  pooler: {
    name: "pooler",
    configKey: "pooler",
    defaultVersions: { native: "v2.9.10", docker: "2.9.7" },
    artifact: {
      docker: { registry: SUPABASE_GHCR_REGISTRY, repository: "supavisor" },
      native: nativeSource("pooler", ["bin/migrate", "bin/supavisor", "bin/server"]),
    },
    activation: { activates: [], owns: [] },
    preparation: preparation(["eager"], "eager", ["postgres"]),
    portFields: ["poolerSessionPort", "poolerTransactionPort", "poolerApiPort"],
  },
};

export const SERVICE_NAMES: ReadonlyArray<ServiceName> = Record.keys(SERVICE_CATALOG);

export const DEFAULT_VERSIONS: Readonly<Record<ServiceName, string>> = Record.map(
  SERVICE_CATALOG,
  (metadata) => metadata.defaultVersions.native,
);

export const DOCKER_DEFAULT_VERSIONS: Readonly<Record<ServiceName, string>> = Record.map(
  SERVICE_CATALOG,
  (metadata) => metadata.defaultVersions.docker,
);

export const serviceMetadata = <Name extends ServiceName>(
  service: Name,
): ServiceCatalogEntry<Name> => SERVICE_CATALOG[service];

export const nativeReleaseForService = (
  service: ServiceName,
  version: string,
  platform: PlatformInfo,
): NativeReleaseArtifact | undefined =>
  serviceMetadata(service).artifact.native.resolve(version, platform);

export const DEFAULT_SERVICE_POLICIES: Readonly<
  Record<ServiceName, Exclude<ServicePreparationPolicy, "off">>
> = Record.map(SERVICE_CATALOG, (metadata) => metadata.preparation.default);

export const requiredPreparationDependencies = (service: ServiceName): ReadonlyArray<ServiceName> =>
  serviceMetadata(service).preparation.dependencies;

export const dockerImageForArtifact = (service: ServiceName, version: string): string => {
  const source = serviceMetadata(service).artifact.docker;
  return `${source.registry ?? SUPABASE_CLI_GHCR_REGISTRY}/${source.repository}:${source.tagPrefix ?? ""}${version}`;
};
