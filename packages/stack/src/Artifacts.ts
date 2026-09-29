import { Data, Effect, Path, Record } from "effect";
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

export class ArtifactError extends Data.TaggedError("ArtifactError")<{
  readonly message: string;
  readonly service?: string;
  readonly version?: string;
  readonly platform?: string;
  readonly cause?: unknown;
}> {}

/** Lowercase hexadecimal SHA-256 digest. */
type Sha256 = string;

/** Content digests of one native target's published archive and manifest. */
export interface NativePin {
  readonly archive: Sha256;
  readonly manifest: Sha256;
}

/** One published slim-services revision of an upstream version, pinned by content. */
export interface ArtifactPin {
  readonly upstreamVersion: string;
  readonly revision: number;
  /** `ghcr.io/supabase/cli/<service>:<release version>@sha256:<digest>`. */
  readonly image: string;
  readonly natives: Readonly<Record<NativeTarget, NativePin>>;
}

/** The published release version, `<upstream>-r<revision>`. */
const releaseVersion = (pin: ArtifactPin): string => `${pin.upstreamVersion}-r${pin.revision}`;

interface ArtifactResolution {
  readonly service: ServiceKind;
  /** Upstream version. */
  readonly version: string;
  readonly releaseVersion: string;
  readonly image: string;
  readonly natives: ArtifactPin["natives"];
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
  /** Pins keyed by upstream version. */
  readonly pins: Readonly<Record<string, ArtifactPin>>;
  readonly requiredRuntimePaths: ReadonlyArray<string>;
  readonly executablePath: string;
}

const definition = (
  sourceService: string,
  pin: ArtifactPin,
  executablePath: string,
  requiredRuntimePaths: ReadonlyArray<string> = [executablePath],
  additionalPins: Readonly<Record<string, ArtifactPin>> = {},
): ArtifactDefinition => ({
  sourceService,
  defaultVersion: pin.upstreamVersion,
  pins: { [pin.upstreamVersion]: pin, ...additionalPins },
  requiredRuntimePaths,
  executablePath,
});

const SLIM_IMAGE_GHCR_REGISTRY = "ghcr.io/supabase/cli/";

/** Stand-in digest of every catalog pin that no published revision backs yet. */
export const PLACEHOLDER_PINS = "0".repeat(64);

const placeholderPin = (repository: string, upstreamVersion: string): ArtifactPin => {
  const native = { archive: PLACEHOLDER_PINS, manifest: PLACEHOLDER_PINS };
  return {
    upstreamVersion,
    revision: 0,
    image: `${SLIM_IMAGE_GHCR_REGISTRY}${repository}:${upstreamVersion}-r0@sha256:${PLACEHOLDER_PINS}`,
    natives: { "darwin-arm64": native, "linux-amd64": native, "linux-arm64": native },
  };
};

const definitions: Readonly<Record<ServiceKind, ArtifactDefinition>> = {
  database: definition(
    "postgres",
    placeholderPin("postgres", "17.6.1.173"),
    "bin/supabase-postgres-start",
    ["bin/supabase-postgres-start", "bin/pg_dump", "bin/pg_dumpall", "bin/pg_prove", "bin/psql"],
    { "15.14.1.173": placeholderPin("postgres", "15.14.1.173") },
  ),
  rest: definition("postgrest", placeholderPin("postgrest", "v16.2"), "bin/postgrest"),
  auth: definition("auth", placeholderPin("auth", "v2.196.0"), "bin/auth"),
  realtime: definition("realtime", placeholderPin("realtime", "v2.134.5"), "bin/server", [
    "bin/server",
    "bin/prepare",
  ]),
  storage: definition("storage", placeholderPin("storage", "v1.73.0"), "bin/storage", [
    "bin/storage",
    "bin/prepare",
  ]),
  imgproxy: definition("imgproxy", placeholderPin("imgproxy", "v3.8.0"), "bin/imgproxy"),
  functions: definition(
    "edge-runtime",
    placeholderPin("edge-runtime", "v1.77.1"),
    "bin/edge-runtime",
  ),
  studio: definition("studio", placeholderPin("studio", "2026.09.04-sha-5a67366"), "bin/studio"),
  pgmeta: definition("pgmeta", placeholderPin("pgmeta", "v0.99.0"), "bin/pgmeta"),
  mail: definition("mailpit", placeholderPin("mailpit", "v1.30.2"), "bin/mailpit"),
  analytics: definition("analytics", placeholderPin("analytics", "v1.50.9"), "bin/logflare", [
    "bin/logflare",
    "bin/prepare",
  ]),
  vector: definition("vector", placeholderPin("vector", "0.53.0"), "bin/vector", [
    "bin/vector",
    "share/doc/vector/config/vector.yaml",
  ]),
  pooler: definition("pooler", placeholderPin("pooler", "v2.9.12"), "bin/server", [
    "bin/server",
    "bin/prepare",
    "bin/provision-tenant",
  ]),
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

/** Selects native execution where the catalog publishes native artifacts, and Docker elsewhere. */
export const defaultRuntime = (
  platform: { readonly os: string; readonly arch: string } = {
    os: process.platform,
    arch: process.arch,
  },
): "native" | "docker" => (targetForPlatform(platform) === undefined ? "docker" : "native");

const platformText = (platform: { readonly os: string; readonly arch: string }): string =>
  `${platform.os}/${platform.arch}`;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

const SLIM_NATIVE_GITHUB_RELEASES = "https://github.com/supabase/slim-services/releases/download";

/**
 * Public S3 copy of the release assets for hosts that block GitHub release downloads, such as
 * agent sandboxes that allow `*.amazonaws.com`.
 * @see ../../../infra/cli-artifacts/README.md
 */
const SLIM_NATIVE_SUPABASE_S3_MIRROR = "https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com";

const SLIM_IMAGE_SUPABASE_ECR_MIRROR = "public.ecr.aws/supabase/cli/";

/** Mirrors carrying a catalog slim image under the same tag and digest, in fallback order. */
export const slimImageMirrors = (image: string): ReadonlyArray<string> =>
  image.startsWith(SLIM_IMAGE_GHCR_REGISTRY)
    ? [`${SLIM_IMAGE_SUPABASE_ECR_MIRROR}${image.slice(SLIM_IMAGE_GHCR_REGISTRY.length)}`]
    : [];

const artifactFor = (
  service: ServiceKind,
  resolved: ArtifactResolution,
  target: NativeTarget,
): SlimServicesArtifact => {
  const sourceService = definitions[service].sourceService;
  const releaseTag = `${sourceService}-${resolved.releaseVersion}`;
  const assetName = `${releaseTag}-${target}`;
  const githubRelease = `${SLIM_NATIVE_GITHUB_RELEASES}/${releaseTag}`;
  const supabaseS3 = `${SLIM_NATIVE_SUPABASE_S3_MIRROR}/${sourceService}/${resolved.releaseVersion}`;
  const pin = resolved.natives[target];
  return {
    provider: "supabase/slim-services",
    service: sourceService,
    version: resolved.releaseVersion,
    releaseTag,
    target,
    archive: "tar.zst",
    assetName,
    sha256: pin.archive,
    manifestSha256: pin.manifest,
    mirrors: [
      {
        downloadUrl: `${githubRelease}/${assetName}.tar.zst`,
        manifestUrl: `${githubRelease}/${assetName}.manifest.json`,
      },
      {
        downloadUrl: `${supabaseS3}/${assetName}.tar.zst`,
        manifestUrl: `${supabaseS3}/${assetName}.manifest.json`,
      },
    ],
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
  const pin = Object.entries(selected.pins).find(([candidate]) => candidate === version)?.[1];
  if (pin === undefined)
    return yield* new ArtifactError({
      message: `Unsupported ${request.service} artifact version: ${version}`,
      service: request.service,
      version,
    });
  return {
    service: request.service,
    version,
    releaseVersion: releaseVersion(pin),
    image: pin.image,
    natives: pin.natives,
    executablePath: selected.executablePath,
    requiredRuntimePaths: selected.requiredRuntimePaths,
  };
});

/** Resolves a PostgreSQL major alias against the pinned database artifacts. */
export const postgresVersion = (version: string): string =>
  Object.keys(definitions.database.pins).find((candidate) => candidate.split(".")[0] === version) ??
  version;

/** Service kinds in artifact catalog order. */
export const artifactServiceKinds = (): ReadonlyArray<ServiceKind> => Record.keys(definitions);

/** Every catalog pin in catalog order, including additional upstream lines. */
export const catalogPins = (): ReadonlyArray<{
  readonly service: ServiceKind;
  readonly sourceService: string;
  readonly pin: ArtifactPin;
}> =>
  artifactServiceKinds().flatMap((service) => {
    const { sourceService, pins } = definitions[service];
    return Object.values(pins).map((pin) => ({ service, sourceService, pin }));
  });

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
