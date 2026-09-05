import type { PlannedWorkload } from "./ExecutionPlan.ts";
import { Effect } from "effect";
import { StackPreparationError } from "../public/Errors.ts";

export type NativeTarget = "darwin-arm64" | "linux-amd64" | "linux-arm64";

export interface NativeWorkloadArtifact {
  readonly provider: "supabase/slim-services";
  readonly service: string;
  readonly version: string;
  readonly releaseTag: string;
  readonly target: NativeTarget;
  readonly archive: "tar.zst";
  readonly assetName: string;
  readonly downloadUrl: string;
  readonly manifestUrl: string;
  readonly checksumUrl: string;
  readonly requiredRuntimePaths: ReadonlyArray<string>;
  readonly executablePath: string;
}

export interface WorkloadCatalogEntry {
  readonly service: string;
  readonly defaultVersion: string;
  /** Supported exact versions mapped to their matching container image. */
  readonly releases: Readonly<Record<string, string>>;
  readonly requiredRuntimePaths: ReadonlyArray<string>;
  readonly executablePath: string;
  /** Stable, stack-local DNS identity used by container dependants. */
  readonly containerAlias: string;
}

const native = (
  service: string,
  defaultVersion: string,
  containerImage: string,
  executablePath: string,
  requiredRuntimePaths: ReadonlyArray<string> = [executablePath],
  options: {
    readonly additionalReleases?: Readonly<Record<string, string>>;
    readonly containerAlias?: string;
  } = {},
): WorkloadCatalogEntry => ({
  service,
  defaultVersion,
  releases: {
    [defaultVersion]: containerImage,
    ...options.additionalReleases,
  },
  requiredRuntimePaths,
  executablePath,
  containerAlias: options.containerAlias ?? `supabase-${service}`,
});

/** The single authoritative private workload identity table. */
const workloadCatalog = {
  "database:database": native(
    "postgres",
    "17.6.1.168",
    "ghcr.io/supabase/cli/postgres:17.6.1.168@sha256:88747ff441dc313edab7f2bc14f2586d7fee5cc7c44d6425729756d1ef7e0f89",
    "bin/supabase-postgres-start",
    ["bin/supabase-postgres-start"],
    {
      additionalReleases: {
        "15.14.1.168":
          "ghcr.io/supabase/cli/postgres:15.14.1.168@sha256:f8cd66cf9d464374fe8932a319c6bb0ab03520643ee038b4e84bbdb8ad03bd8f",
      },
      containerAlias: "supabase-database",
    },
  ),
  "rest:rest": native(
    "postgrest",
    "v16.2",
    "ghcr.io/supabase/cli/postgrest:v16.2",
    "bin/postgrest",
    ["bin/postgrest"],
    { containerAlias: "supabase-rest" },
  ),
  "auth:auth": native("auth", "v2.196.0", "ghcr.io/supabase/cli/auth:v2.196.0", "bin/auth", [
    "bin/auth",
  ]),
  "realtime:realtime": native(
    "realtime",
    "v2.134.5",
    "ghcr.io/supabase/cli/realtime:v2.134.5@sha256:ebed084dc805ca8d9dc0ab37a84f858c82c1ccd9afcf4bff332941ea0d089347",
    "bin/server",
    ["bin/server", "bin/prepare"],
  ),
  "storage:storage": native(
    "storage",
    "v1.73.0",
    "ghcr.io/supabase/cli/storage:v1.73.0@sha256:c645e251ecdb393b370413697f5a5ed48c853d1c068c4698fece8d2914f5d8aa",
    "bin/storage",
    ["bin/storage", "bin/prepare"],
  ),
  "storage:imgproxy": native(
    "imgproxy",
    "v3.8.0",
    "ghcr.io/supabase/cli/imgproxy:v3.8.0",
    "bin/imgproxy",
  ),
  "functions:edge-runtime": native(
    "edge-runtime",
    "v1.76.2",
    "ghcr.io/supabase/cli/edge-runtime:v1.76.2",
    "bin/edge-runtime",
    ["bin/edge-runtime"],
    { containerAlias: "supabase-functions" },
  ),
  "studio:studio": native(
    "studio",
    "2026.09.04-sha-5a67366",
    "ghcr.io/supabase/cli/studio:2026.09.04-sha-5a67366@sha256:b33221c99519400d648b98e0c31004f8897104c3970d0ef169392c3f3d22c22c",
    "bin/studio",
    ["bin/studio"],
  ),
  "studio:pgmeta": native(
    "pgmeta",
    "v0.99.0",
    "ghcr.io/supabase/cli/pgmeta:v0.99.0@sha256:efe57d66dafa2921f7c1af3283e40432dd66eba190ea84d3d9d1eda629c64ff0",
    "bin/pgmeta",
    ["bin/pgmeta"],
  ),
  "mail:mail": native(
    "mailpit",
    "v1.30.2",
    "ghcr.io/supabase/cli/mailpit:v1.30.2",
    "bin/mailpit",
    ["bin/mailpit"],
    { containerAlias: "supabase-mail" },
  ),
  "analytics:analytics": native(
    "analytics",
    "v1.50.9",
    "ghcr.io/supabase/cli/analytics:v1.50.9@sha256:5a1bc151a4e53f84012a1b459db9e64bdd72945b115633896e8df004861c988f",
    "bin/logflare",
    ["bin/logflare", "bin/prepare"],
  ),
  "analytics:vector": native(
    "vector",
    "0.53.0",
    "ghcr.io/supabase/cli/vector:0.53.0",
    "bin/vector",
    ["bin/vector", "share/doc/vector/config/vector.yaml"],
  ),
  "pooler:pooler": native(
    "pooler",
    "v2.9.12",
    "ghcr.io/supabase/cli/pooler:v2.9.12@sha256:eb011c14a6dd569f795397215887357d6ce45ebadf387efd32af7bb81afb7a73",
    "bin/server",
    ["bin/server", "bin/prepare", "bin/provision-tenant"],
  ),
} satisfies Readonly<Record<string, WorkloadCatalogEntry>>;

export const WORKLOAD_CATALOG: Readonly<Record<string, WorkloadCatalogEntry>> = workloadCatalog;
export type WorkloadId = keyof typeof workloadCatalog;

export const targetForPlatform = (platform: {
  readonly os: string;
  readonly arch: string;
}): NativeTarget | undefined => {
  if (platform.os === "darwin" && platform.arch === "arm64") return "darwin-arm64";
  if (platform.os === "linux" && platform.arch === "x64") return "linux-amd64";
  if (platform.os === "linux" && platform.arch === "arm64") return "linux-arm64";
  return undefined;
};

/** Returns the catalog entry for a workload. Known workload IDs are always present. */
export function catalogEntryFor(workloadId: WorkloadId): WorkloadCatalogEntry;
export function catalogEntryFor(workloadId: string): WorkloadCatalogEntry | undefined;
export function catalogEntryFor(workloadId: string): WorkloadCatalogEntry | undefined {
  return WORKLOAD_CATALOG[workloadId];
}

export interface WorkloadCatalogRelease {
  readonly version: string;
  readonly containerImage: string;
}

/** Returns one exact native/container release pair for a workload. */
export const catalogReleaseFor = (
  workloadId: string,
  version?: string,
): WorkloadCatalogRelease | undefined => {
  const entry = catalogEntryFor(workloadId);
  if (entry === undefined) return undefined;
  const selected = version ?? entry.defaultVersion;
  const containerImage = entry.releases[selected];
  return containerImage === undefined ? undefined : { version: selected, containerImage };
};

/** Resolves the container alias for a catalog workload identity. */
export const containerAliasFor = (workloadId: WorkloadId): string =>
  workloadCatalog[workloadId].containerAlias;

const artifactFor = (
  entry: WorkloadCatalogEntry,
  release: WorkloadCatalogRelease,
  target: NativeTarget,
): NativeWorkloadArtifact => {
  const version = release.version;
  const releaseTag = `${entry.service}-${version}`;
  const assetName = `${releaseTag}-${target}`;
  const base = `https://github.com/supabase/slim-services/releases/download/${releaseTag}`;
  return {
    provider: "supabase/slim-services",
    service: entry.service,
    version,
    releaseTag,
    target,
    archive: "tar.zst",
    assetName,
    downloadUrl: `${base}/${assetName}.tar.zst`,
    manifestUrl: `${base}/${assetName}.manifest.json`,
    checksumUrl: `${base}/SHA256SUMS`,
    requiredRuntimePaths: entry.requiredRuntimePaths,
    executablePath: entry.executablePath,
  };
};

/** Effect-native resolver used by preparation/runtime boundaries. */
export const resolveNativeArtifactForWorkload = (
  workload: Pick<PlannedWorkload, "id" | "artifacts">,
  platform: { readonly os: string; readonly arch: string } = {
    os: process.platform,
    arch: process.arch,
  },
): Effect.Effect<NativeWorkloadArtifact, StackPreparationError> => {
  const entry = catalogEntryFor(workload.id);
  if (entry === undefined)
    return Effect.fail(
      new StackPreparationError({
        message: `Unknown workload catalog entry: ${workload.id}`,
        workload: workload.id,
      }),
    );
  const target = targetForPlatform(platform);
  if (target === undefined)
    return Effect.fail(
      new StackPreparationError({
        message: `Native runtime is unsupported on ${platform.os}/${platform.arch}`,
        workload: workload.id,
        platform: `${platform.os}/${platform.arch}`,
      }),
    );
  const release = catalogReleaseFor(workload.id, workload.artifacts.native.release);
  if (release === undefined)
    return Effect.fail(
      new StackPreparationError({
        message: `Unsupported native release ${workload.artifacts.native.release}`,
        workload: workload.id,
        service: entry.service,
        version: workload.artifacts.native.release,
      }),
    );
  return Effect.succeed(artifactFor(entry, release, target));
};
