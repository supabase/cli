import { Effect, Result, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import type { NativeFetchCandidate } from "../model/SlimArtifactMirrors.ts";
import { StackPreparationError } from "../public/Errors.ts";

export const ARCHIVE_MEDIA_TYPE = "application/vnd.supabase.slim.archive.v1.tar+zstd";
export const MANIFEST_MEDIA_TYPE = "application/vnd.supabase.slim.manifest.v1+json";
export const CHECKSUM_MEDIA_TYPE = "application/vnd.supabase.slim.checksum.v1";

const MANIFEST_ACCEPT =
  "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.artifact.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

interface OciLayer {
  readonly mediaType: string;
  readonly digest: string;
  readonly annotations: Readonly<Record<string, string>>;
}

export interface OciNativeTriplet {
  readonly manifestBytes: Uint8Array;
  readonly checksumText: string;
  readonly archiveDigest: string;
  readonly archiveUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

const tokenUrl = (registry: string, repository: string): string => {
  if (registry === "ghcr.io")
    return `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`;
  if (registry === "public.ecr.aws")
    return `https://public.ecr.aws/token/?service=public.ecr.aws&scope=repository:${repository}:pull`;
  return `https://${registry}/token?service=${registry}&scope=repository:${repository}:pull`;
};

const parseToken = (bytes: Uint8Array): string | undefined => {
  const decoded = Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))(
    new TextDecoder().decode(bytes),
  );
  if (Result.isFailure(decoded) || typeof decoded.success !== "object" || decoded.success === null)
    return undefined;
  const record = decoded.success as Record<string, unknown>;
  for (const key of ["token", "access_token", "authorizationToken"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
};

const asLayers = (manifest: unknown): ReadonlyArray<OciLayer> => {
  if (typeof manifest !== "object" || manifest === null) return [];
  const record = manifest as Record<string, unknown>;
  const raw = record["layers"] ?? record["blobs"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const layer = entry as Record<string, unknown>;
    const mediaType = typeof layer["mediaType"] === "string" ? layer["mediaType"] : "";
    const digest = typeof layer["digest"] === "string" ? layer["digest"] : "";
    if (digest.length === 0) return [];
    const annotations =
      typeof layer["annotations"] === "object" && layer["annotations"] !== null
        ? (layer["annotations"] as Record<string, string>)
        : {};
    return [{ mediaType, digest, annotations }];
  });
};

const titleOf = (layer: OciLayer): string =>
  layer.annotations["org.opencontainers.image.title"] ?? "";

const findLayer = (
  layers: ReadonlyArray<OciLayer>,
  match: (layer: OciLayer) => boolean,
): OciLayer | undefined => layers.find(match);

const responseFor = (url: string, headers?: Readonly<Record<string, string>>) =>
  HttpClient.get(url, headers === undefined ? undefined : { headers }).pipe(
    Effect.flatMap((response) =>
      Effect.gen(function* () {
        if (response.status < 200 || response.status >= 300)
          return yield* new StackPreparationError({ message: `HTTP ${response.status}` });
        return response;
      }),
    ),
  );

const fetchBytes = (
  url: string,
  headers?: Readonly<Record<string, string>>,
): Effect.Effect<Uint8Array, StackPreparationError, HttpClient.HttpClient> =>
  responseFor(url, headers).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((bytes) => new Uint8Array(bytes)),
    Effect.mapError(
      (cause) => new StackPreparationError({ message: `Unable to download ${url}`, cause }),
    ),
  );

const bearerHeaders = (token: string, accept?: string): Readonly<Record<string, string>> => ({
  Authorization: `Bearer ${token}`,
  ...(accept === undefined ? {} : { Accept: accept }),
});

const ociToken = (
  registry: string,
  repository: string,
): Effect.Effect<string, StackPreparationError, HttpClient.HttpClient> =>
  fetchBytes(tokenUrl(registry, repository)).pipe(
    Effect.flatMap((bytes) => {
      const token = parseToken(bytes);
      return token === undefined
        ? Effect.fail(new StackPreparationError({ message: `OCI token missing from ${registry}` }))
        : Effect.succeed(token);
    }),
  );

export const fetchOciNativeTriplet = (
  candidate: Extract<NativeFetchCandidate, { readonly kind: "oci" }>,
): Effect.Effect<OciNativeTriplet, StackPreparationError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const token = yield* ociToken(candidate.registry, candidate.repository);
    const manifestUrl = `https://${candidate.registry}/v2/${candidate.repository}/manifests/${candidate.tag}`;
    const manifestBytes = yield* fetchBytes(manifestUrl, bearerHeaders(token, MANIFEST_ACCEPT));
    const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
      new TextDecoder().decode(manifestBytes),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new StackPreparationError({ message: "OCI native manifest is invalid JSON", cause }),
      ),
    );
    const layers = asLayers(parsed);
    const archive = findLayer(
      layers,
      (layer) => layer.mediaType === ARCHIVE_MEDIA_TYPE || titleOf(layer).endsWith(".tar.zst"),
    );
    const slimManifest = findLayer(
      layers,
      (layer) =>
        layer.mediaType === MANIFEST_MEDIA_TYPE || titleOf(layer).endsWith(".manifest.json"),
    );
    const checksum = findLayer(
      layers,
      (layer) => layer.mediaType === CHECKSUM_MEDIA_TYPE || titleOf(layer).includes("SHA256SUMS"),
    );
    if (archive === undefined || slimManifest === undefined || checksum === undefined)
      return yield* new StackPreparationError({
        message: `OCI native triplet is incomplete for ${candidate.registry}/${candidate.repository}:${candidate.tag}`,
      });
    const blob = (digest: string) =>
      fetchBytes(
        `https://${candidate.registry}/v2/${candidate.repository}/blobs/${digest}`,
        bearerHeaders(token),
      );
    const slimManifestBytes = yield* blob(slimManifest.digest);
    const checksumBytes = yield* blob(checksum.digest);
    return {
      manifestBytes: slimManifestBytes,
      checksumText: new TextDecoder().decode(checksumBytes),
      archiveDigest: archive.digest,
      archiveUrl: `https://${candidate.registry}/v2/${candidate.repository}/blobs/${archive.digest}`,
      headers: bearerHeaders(token),
    };
  });
