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
  readonly nativeProcess?: NativeWorkloadProcess;
  readonly containerAlias: string;
}

/** Artifact-root-relative process metadata for native Node workloads. */
export interface NativeWorkloadProcess {
  readonly executablePath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

export interface WorkloadCatalogEntry {
  readonly workloadId: string;
  readonly service: string;
  readonly nativeVersion: string;
  readonly containerImage: string;
  readonly requiredRuntimePaths: ReadonlyArray<string>;
  readonly executablePath: string;
  /** Stable, stack-local DNS identity used by container dependants. */
  readonly containerAlias: string;
  /** Present when the artifact is launched through an interpreter. */
  readonly nativeProcess?: NativeWorkloadProcess;
}

const native = (
  workloadId: string,
  service: string,
  nativeVersion: string,
  containerImage: string,
  executablePath: string,
  requiredRuntimePaths: ReadonlyArray<string> = [executablePath],
  options: {
    readonly containerAlias?: string;
    readonly nativeProcess?: NativeWorkloadProcess;
  } = {},
): WorkloadCatalogEntry => ({
  workloadId,
  service,
  nativeVersion,
  containerImage,
  requiredRuntimePaths,
  executablePath,
  containerAlias: options.containerAlias ?? `supabase-${service}`,
  ...(options.nativeProcess === undefined ? {} : { nativeProcess: options.nativeProcess }),
});

/** The single authoritative private workload identity table. */
const workloadCatalog = {
  "database:database": native(
    "database:database",
    "postgres",
    "17.6.1.167",
    "ghcr.io/supabase/cli/postgres:17.6.1.167",
    "share/supabase-cli/bin/supabase-postgres-init.sh",
    [
      "bin/postgres",
      "bin/pg_isready",
      "bin/psql",
      "share/supabase-cli/bin/supabase-postgres-init.sh",
      "share/supabase-cli/config/pgsodium_getkey.sh",
      "share/supabase-cli/migrations",
      "lib",
    ],
    { containerAlias: "supabase-database" },
  ),
  "rest:rest": native(
    "rest:rest",
    "postgrest",
    "v16.2",
    "ghcr.io/supabase/cli/postgrest:v16.2",
    "bin/postgrest",
    ["bin/postgrest"],
    { containerAlias: "supabase-rest" },
  ),
  "auth:auth": native(
    "auth:auth",
    "auth",
    "v2.196.0",
    "ghcr.io/supabase/cli/auth:v2.196.0",
    "bin/auth",
    ["bin/auth"],
  ),
  "realtime:realtime": native(
    "realtime:realtime",
    "realtime",
    "v2.130.0",
    "ghcr.io/supabase/cli/realtime:v2.130.0",
    "bin/server",
    ["bin/migrate", "bin/realtime", "bin/server"],
  ),
  "storage:storage": native(
    "storage:storage",
    "storage",
    "v1.72.1",
    "ghcr.io/supabase/cli/storage:v1.72.1",
    "app/dist/start/server.js",
    ["node/bin/node", "app/dist/start/server.js", "app/dist/scripts/migrate-call.js"],
    {
      nativeProcess: {
        executablePath: "node/bin/node",
        args: ["app/dist/start/server.js"],
        cwd: "app",
      },
    },
  ),
  "storage:imgproxy": native(
    "storage:imgproxy",
    "imgproxy",
    "v3.8.0",
    "ghcr.io/supabase/cli/imgproxy:v3.8.0",
    "bin/imgproxy",
  ),
  "functions:edge-runtime": native(
    "functions:edge-runtime",
    "edge-runtime",
    "v1.74.3",
    "ghcr.io/supabase/cli/edge-runtime:v1.74.3",
    "bin/edge-runtime",
    ["bin/edge-runtime"],
    { containerAlias: "supabase-functions" },
  ),
  "studio:studio": native(
    "studio:studio",
    "studio",
    "2026.08.24-sha-8ec45b2",
    "ghcr.io/supabase/cli/studio:2026.08.24-sha-8ec45b2",
    "app/apps/studio/server.js",
    ["node/bin/node", "app/apps/studio/docker-entrypoint.mjs", "app/apps/studio/server.js"],
    {
      nativeProcess: {
        executablePath: "node/bin/node",
        args: ["app/apps/studio/docker-entrypoint.mjs"],
        cwd: "app",
      },
    },
  ),
  "studio:pgmeta": native(
    "studio:pgmeta",
    "pgmeta",
    "v0.99.0",
    "ghcr.io/supabase/cli/pgmeta:v0.99.0",
    "app/dist/server/server.js",
    ["node/bin/node", "app/dist/server/server.js"],
    {
      nativeProcess: {
        executablePath: "node/bin/node",
        args: ["app/dist/server/server.js"],
        cwd: "app",
      },
    },
  ),
  "mail:mail": native(
    "mail:mail",
    "mailpit",
    "v1.30.2",
    "ghcr.io/supabase/cli/mailpit:v1.30.2",
    "bin/mailpit",
    ["bin/mailpit"],
    { containerAlias: "supabase-mail" },
  ),
  "analytics:analytics": native(
    "analytics:analytics",
    "analytics",
    "v1.50.6",
    "ghcr.io/supabase/cli/analytics:v1.50.6",
    "bin/logflare",
    ["bin/logflare"],
  ),
  "analytics:vector": native(
    "analytics:vector",
    "vector",
    "0.53.0",
    "ghcr.io/supabase/cli/vector:0.53.0",
    "bin/vector",
    ["bin/vector", "share/doc/vector/config/vector.yaml"],
  ),
  "pooler:pooler": native(
    "pooler:pooler",
    "pooler",
    "v2.9.12",
    "ghcr.io/supabase/cli/pooler:v2.9.12",
    "bin/server",
    ["bin/migrate", "bin/supavisor", "bin/server"],
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

/** Returns the catalog entry for an open workload identity. */
export const catalogEntryFor = (workloadId: string): WorkloadCatalogEntry | undefined =>
  WORKLOAD_CATALOG[workloadId];

/** Resolves the container alias for a catalog workload identity. */
export const containerAliasFor = (workloadId: WorkloadId): string =>
  workloadCatalog[workloadId].containerAlias;

const artifactFor = (entry: WorkloadCatalogEntry, target: NativeTarget): NativeWorkloadArtifact => {
  const version = entry.nativeVersion;
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
    ...(entry.nativeProcess === undefined ? {} : { nativeProcess: entry.nativeProcess }),
    containerAlias: entry.containerAlias,
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
  if (workload.artifacts.native.release !== entry.nativeVersion)
    return Effect.fail(
      new StackPreparationError({
        message: `Unsupported native release ${workload.artifacts.native.release}`,
        workload: workload.id,
        service: entry.service,
        version: workload.artifacts.native.release,
      }),
    );
  return Effect.succeed(artifactFor(entry, target));
};
