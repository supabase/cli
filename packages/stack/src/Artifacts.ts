import { Data, Effect, Path } from "effect";
import { makeArtifactStore } from "./preparation/ArtifactStore.ts";
import {
  makeSlimServicesSource,
  type SlimServicesArtifact,
} from "./preparation/SlimServicesSource.ts";

type NativeTarget = SlimServicesArtifact["target"];

export type ServiceKind =
  | "database"
  | "rest"
  | "auth"
  | "realtime"
  | "storage"
  | "imgproxy"
  | "functions"
  | "studio"
  | "pgmeta"
  | "mail"
  | "analytics"
  | "vector"
  | "pooler";

class ArtifactError extends Data.TaggedError("ArtifactError")<{
  readonly message: string;
  readonly service?: string;
  readonly version?: string;
  readonly platform?: string;
  readonly cause?: unknown;
}> {}

interface ArtifactResolution {
  readonly service: ServiceKind;
  readonly version: string;
  readonly image: string;
  readonly executablePath: string;
  readonly requiredRuntimePaths: ReadonlyArray<string>;
}

export interface PreparedNativeArtifact {
  readonly service: ServiceKind;
  readonly version: string;
  readonly root: string;
  readonly executable: string;
}

interface ArtifactDefinition {
  readonly sourceService: string;
  readonly defaultVersion: string;
  readonly images: Readonly<Record<string, string>>;
  readonly requiredRuntimePaths: ReadonlyArray<string>;
  readonly executablePath: string;
}

const definition = (
  sourceService: string,
  defaultVersion: string,
  image: string,
  executablePath: string,
  requiredRuntimePaths: ReadonlyArray<string> = [executablePath],
  additionalImages: Readonly<Record<string, string>> = {},
): ArtifactDefinition => ({
  sourceService,
  defaultVersion,
  images: { [defaultVersion]: image, ...additionalImages },
  requiredRuntimePaths,
  executablePath,
});

const definitions: Readonly<Record<ServiceKind, ArtifactDefinition>> = {
  database: definition(
    "postgres",
    "17.6.1.173",
    "ghcr.io/supabase/cli/postgres:17.6.1.173@sha256:1581c433d71a48a81e356a3ed2d4aa5ecfc8fc0465ea98661da7a88023317dcf",
    "bin/supabase-postgres-start",
    ["bin/supabase-postgres-start", "bin/pg_dump", "bin/pg_dumpall", "bin/pg_prove", "bin/psql"],
    {
      "15.14.1.173":
        "ghcr.io/supabase/cli/postgres:15.14.1.173@sha256:b7d210fa3bca26568fa20448e3bec092bd4f8da6a5af5029597639d38e7d896e",
    },
  ),
  rest: definition("postgrest", "v16.2", "ghcr.io/supabase/cli/postgrest:v16.2", "bin/postgrest"),
  auth: definition("auth", "v2.196.0", "ghcr.io/supabase/cli/auth:v2.196.0", "bin/auth"),
  realtime: definition(
    "realtime",
    "v2.134.5",
    "ghcr.io/supabase/cli/realtime:v2.134.5@sha256:7fb53cc6987085d739c7d161608505ed138d1895df884c3bdc2147cef444138a",
    "bin/server",
    ["bin/server", "bin/prepare"],
  ),
  storage: definition(
    "storage",
    "v1.73.0",
    "ghcr.io/supabase/cli/storage:v1.73.0@sha256:69590a75f916837641976d4018e5ead7c7d2c2305312d9bfb06d86aec8fb1cdd",
    "bin/storage",
    ["bin/storage", "bin/prepare"],
  ),
  imgproxy: definition(
    "imgproxy",
    "v3.8.0",
    "ghcr.io/supabase/cli/imgproxy:v3.8.0",
    "bin/imgproxy",
  ),
  functions: definition(
    "edge-runtime",
    "v1.76.2",
    "ghcr.io/supabase/cli/edge-runtime:v1.76.2",
    "bin/edge-runtime",
  ),
  studio: definition(
    "studio",
    "2026.09.04-sha-5a67366",
    "ghcr.io/supabase/cli/studio:2026.09.04-sha-5a67366@sha256:9823a31668028f1846e87331bc21598d9cd74bcaa1466c72dab58c33c9c82720",
    "bin/studio",
  ),
  pgmeta: definition(
    "pgmeta",
    "v0.99.0",
    "ghcr.io/supabase/cli/pgmeta:v0.99.0@sha256:90de2dcf03ac548ae2d1d3e71b3cd10bde4c627572720a42e4c3946b7090292e",
    "bin/pgmeta",
  ),
  mail: definition("mailpit", "v1.30.2", "ghcr.io/supabase/cli/mailpit:v1.30.2", "bin/mailpit"),
  analytics: definition(
    "analytics",
    "v1.50.9",
    "ghcr.io/supabase/cli/analytics:v1.50.9@sha256:7db85cc6cb0cdeb4b71f2fadb49c0f9197bea0492daf7896f6ae69edad76d28e",
    "bin/logflare",
    ["bin/logflare", "bin/prepare"],
  ),
  vector: definition("vector", "0.53.0", "ghcr.io/supabase/cli/vector:0.53.0", "bin/vector", [
    "bin/vector",
    "share/doc/vector/config/vector.yaml",
  ]),
  pooler: definition(
    "pooler",
    "v2.9.12",
    "ghcr.io/supabase/cli/pooler:v2.9.12@sha256:12bb9dcb7ddace79bee173ccb7327c6646af2236679f3bd932a86b3a06479aac",
    "bin/server",
    ["bin/server", "bin/prepare", "bin/provision-tenant"],
  ),
};

const targetForPlatform = (platform: {
  readonly os: string;
  readonly arch: string;
}): NativeTarget | undefined => {
  if (platform.os === "darwin" && platform.arch === "arm64") return "darwin-arm64";
  if (platform.os === "linux" && platform.arch === "x64") return "linux-amd64";
  if (platform.os === "linux" && platform.arch === "arm64") return "linux-arm64";
  return undefined;
};

const platformText = (platform: { readonly os: string; readonly arch: string }): string =>
  `${platform.os}/${platform.arch}`;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

const artifactFor = (
  service: ServiceKind,
  resolved: ArtifactResolution,
  target: NativeTarget,
): SlimServicesArtifact => {
  const sourceService = definitions[service].sourceService;
  const releaseTag = `${sourceService}-${resolved.version}`;
  const assetName = `${releaseTag}-${target}`;
  const base = `https://github.com/supabase/slim-services/releases/download/${releaseTag}`;
  return {
    provider: "supabase/slim-services",
    service: sourceService,
    version: resolved.version,
    releaseTag,
    target,
    archive: "tar.zst",
    assetName,
    downloadUrl: `${base}/${assetName}.tar.zst`,
    manifestUrl: `${base}/${assetName}.manifest.json`,
    checksumUrl: `${base}/SHA256SUMS`,
    requiredRuntimePaths: resolved.requiredRuntimePaths,
    executablePath: resolved.executablePath,
  };
};

export const resolveArtifact = Effect.fn("Artifacts.resolveArtifact")(function* (request: {
  readonly service: ServiceKind;
  readonly version?: string;
}) {
  if (!Object.hasOwn(definitions, request.service))
    return yield* new ArtifactError({ message: `Unknown service kind: ${request.service}` });
  const selected = definitions[request.service];
  const version = request.version ?? selected.defaultVersion;
  const image = Object.entries(selected.images).find(([candidate]) => candidate === version)?.[1];
  if (image === undefined)
    return yield* new ArtifactError({
      message: `Unsupported ${request.service} artifact version: ${version}`,
      service: request.service,
      version,
    });
  return {
    service: request.service,
    version,
    image,
    executablePath: selected.executablePath,
    requiredRuntimePaths: selected.requiredRuntimePaths,
  };
});

/** Resolves a PostgreSQL major alias against the pinned database artifacts. */
export const postgresVersion = (version: string): string =>
  Object.keys(definitions.database.images).find(
    (candidate) => candidate.split(".")[0] === version,
  ) ?? version;

const artifactKey = (artifact: SlimServicesArtifact): string =>
  `slim-services/${artifact.service}/${artifact.version}/${artifact.target}`;

export const prepareNativeArtifact = Effect.fn("Artifacts.prepareNativeArtifact")(function* (
  request: { readonly service: ServiceKind; readonly version?: string },
  cacheRoot: string,
  platform: { readonly os: string; readonly arch: string } = {
    os: process.platform,
    arch: process.arch,
  },
) {
  const resolved = yield* resolveArtifact(request);
  return yield* Effect.gen(function* () {
    const target = targetForPlatform(platform);
    if (target === undefined)
      return yield* new ArtifactError({
        message: `Native artifacts are unsupported on ${platformText(platform)}`,
        service: request.service,
        version: resolved.version,
        platform: platformText(platform),
      });
    const sourceArtifact = artifactFor(request.service, resolved, target);
    const key = artifactKey(sourceArtifact);
    const source = makeSlimServicesSource((candidate) =>
      candidate.key === key ? sourceArtifact : undefined,
    );
    const store = yield* makeArtifactStore({ cacheRoot, source });
    const prepared = yield* store.prepare({
      key,
      requiredRuntimePaths: resolved.requiredRuntimePaths,
      executablePath: resolved.executablePath,
    });
    const path = yield* Path.Path;
    return {
      service: resolved.service,
      version: resolved.version,
      root: prepared.path,
      executable: path.join(prepared.path, resolved.executablePath),
    };
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ArtifactError
        ? cause
        : new ArtifactError({
            message: `Unable to prepare ${request.service} artifact: ${errorMessage(cause)}`,
            service: request.service,
            version: resolved.version,
            cause,
          }),
    ),
  );
});
