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
  readonly workloadId: string;
  readonly service: string;
  readonly nativeVersion: string;
  readonly supportedNativeVersions: ReadonlyArray<string>;
  readonly containerImage: string;
  readonly requiredRuntimePaths: ReadonlyArray<string>;
  readonly executablePath: string;
}

const native = (
  workloadId: string,
  service: string,
  nativeVersion: string,
  containerImage: string,
  executablePath: string,
  requiredRuntimePaths: ReadonlyArray<string> = [executablePath],
  supportedNativeVersions: ReadonlyArray<string> = [nativeVersion],
): WorkloadCatalogEntry => ({
  workloadId,
  service,
  nativeVersion,
  supportedNativeVersions,
  containerImage,
  requiredRuntimePaths,
  executablePath,
});

/** The single authoritative private workload identity table. */
export const WORKLOAD_CATALOG: Readonly<Record<string, WorkloadCatalogEntry>> = {
  "database:database": native(
    "database:database",
    "postgres",
    "17.6.1.165",
    "supabase/postgres:17.6.1.165",
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
    ["14.1.0.89", "15.8.1.085", "17.6.1.165"],
  ),
  "rest:rest": native(
    "rest:rest",
    "postgrest",
    "v16.2",
    "postgrest/postgrest:v16.2",
    "bin/postgrest",
  ),
  "auth:auth": native("auth:auth", "auth", "v2.196.0", "supabase/auth:v2.196.0", "bin/auth"),
  "realtime:realtime": native(
    "realtime:realtime",
    "realtime",
    "v2.129.9",
    "supabase/realtime:v2.129.9",
    "app/bin/server",
    ["usr/bin/tini", "usr/bin/sh", "app/entry.sh", "app/bin/server"],
  ),
  "storage:storage": native(
    "storage:storage",
    "storage",
    "v1.71.0",
    "supabase/storage-api:v1.71.0",
    "app/dist/start/server.js",
    ["node/bin/node", "app/dist/start/server.js"],
  ),
  "storage:imgproxy": native(
    "storage:imgproxy",
    "imgproxy",
    "v3.8.0",
    "darthsim/imgproxy:v3.8.0",
    "bin/imgproxy",
  ),
  "functions:edge-runtime": native(
    "functions:edge-runtime",
    "edge-runtime",
    "v1.74.3",
    "supabase/edge-runtime:v1.74.3",
    "bin/.edge-runtime-wrapped",
  ),
  "studio:studio": native(
    "studio:studio",
    "studio",
    "2026.08.24-sha-8ec45b2",
    "supabase/studio:2026.08.24-sha-8ec45b2",
    "app/apps/studio/server.js",
    ["node/bin/node", "app/apps/studio/docker-entrypoint.mjs", "app/apps/studio/server.js"],
  ),
  "studio:pgmeta": native(
    "studio:pgmeta",
    "pgmeta",
    "v0.98.0",
    "supabase/pg-meta:v0.98.0",
    "app/dist/server/server.js",
    ["node/bin/node", "app/dist/server/server.js"],
    ["0.98.0", "v0.98.0"],
  ),
  "mail:mail": native("mail:mail", "mailpit", "v1.30.2", "axllent/mailpit:v1.30.2", "bin/mailpit"),
  "analytics:analytics": native(
    "analytics:analytics",
    "analytics",
    "v1.50.6",
    "supabase/logflare:v1.50.6",
    "app/entry.sh",
    ["usr/bin/tini", "usr/bin/sh", "app/entry.sh"],
  ),
  "analytics:vector": native(
    "analytics:vector",
    "vector",
    "0.53.0",
    "ghcr.io/supabase/vector:0.53.0-alpine",
    "bin/vector",
    ["bin/vector"],
    ["0.53.0", "0.53.0-alpine"],
  ),
  "pooler:pooler": native(
    "pooler:pooler",
    "pooler",
    "v2.9.12",
    "ghcr.io/supabase/supavisor:v2.9.12",
    "app/bin/server",
    [
      "usr/bin/tini",
      "usr/bin/sh",
      "app/entry.sh",
      "app/bin/migrate",
      "app/bin/supavisor",
      "app/bin/server",
    ],
  ),
};

export const targetForPlatform = (platform: {
  readonly os: string;
  readonly arch: string;
}): NativeTarget | undefined => {
  if (platform.os === "darwin" && platform.arch === "arm64") return "darwin-arm64";
  if (platform.os === "linux" && platform.arch === "x64") return "linux-amd64";
  if (platform.os === "linux" && platform.arch === "arm64") return "linux-arm64";
  return undefined;
};

const artifactFor = (
  entry: WorkloadCatalogEntry,
  target: NativeTarget,
  releaseOverride?: string,
): NativeWorkloadArtifact => {
  const version = releaseOverride ?? entry.nativeVersion;
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
  const entry = WORKLOAD_CATALOG[workload.id];
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
  const normalizedVersion =
    workload.id === "studio:pgmeta"
      ? "v0.98.0"
      : workload.id === "analytics:vector"
        ? "0.53.0"
        : workload.artifacts.native.release;
  if (!entry.supportedNativeVersions.includes(workload.artifacts.native.release))
    return Effect.fail(
      new StackPreparationError({
        message: `Unsupported native release ${workload.artifacts.native.release}`,
        workload: workload.id,
        service: entry.service,
        version: workload.artifacts.native.release,
      }),
    );
  return Effect.succeed(artifactFor(entry, target, normalizedVersion));
};
