import { Effect, FileSystem, Path, Schedule, Schema, Stream } from "effect";
import { NodeStream } from "@effect/platform-node";
import { HttpClient, HttpClientError } from "effect/unstable/http";
import { createZstdDecompress } from "node:zlib";
import { createHash } from "node:crypto";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ArtifactRequest, ArtifactSource } from "./ArtifactStore.ts";
import { PreparationError } from "./Errors.ts";

/** One host serving the archive and manifest of a slim-services release asset. */
interface SlimServicesMirror {
  readonly downloadUrl: string;
  readonly manifestUrl: string;
}

/**
 * Where the expected archive digest comes from: a release `SHA256SUMS` file, or the archive layer
 * of the native OCI artifact in a registry that allows anonymous pulls.
 */
type SlimServicesChecksumSource =
  | { readonly kind: "sha256sums"; readonly url: string }
  | {
      readonly kind: "oci";
      readonly registry: string;
      readonly repository: string;
      readonly tag: string;
    };

export interface SlimServicesArtifact {
  readonly provider: "supabase/slim-services";
  readonly service: string;
  readonly version: string;
  readonly releaseTag: string;
  readonly target: "darwin-arm64" | "linux-amd64" | "linux-arm64";
  readonly archive: "tar.zst";
  readonly assetName: string;
  /** Checksum authorities, tried in order. Download mirrors never supply their own checksum. */
  readonly checksums: readonly [
    SlimServicesChecksumSource,
    ...ReadonlyArray<SlimServicesChecksumSource>,
  ];
  /** Hosts carrying the same release assets, tried in order until one serves them. */
  readonly mirrors: readonly [SlimServicesMirror, ...ReadonlyArray<SlimServicesMirror>];
  readonly requiredRuntimePaths: ReadonlyArray<string>;
  readonly executablePath: string;
}

export interface ZstdDecompressor {
  readonly decompress: (
    compressedPath: string,
    outputPath: string,
  ) => Effect.Effect<void, PreparationError, FileSystem.FileSystem>;
}

export interface TarBoundary {
  readonly list: (
    archivePath: string,
  ) => Effect.Effect<string, PreparationError, ChildProcessSpawner.ChildProcessSpawner>;
  readonly links: (
    archivePath: string,
  ) => Effect.Effect<string, PreparationError, ChildProcessSpawner.ChildProcessSpawner>;
  readonly extract: (
    archivePath: string,
    destination: string,
  ) => Effect.Effect<number, PreparationError, ChildProcessSpawner.ChildProcessSpawner>;
}

/** The system tar boundary is argv-based so archive paths never enter a shell string. */
const systemTarBoundary: TarBoundary = {
  list: Effect.fn("SlimServicesSource.tarList")(function* (archivePath) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .string(ChildProcess.make("tar", ["-tf", archivePath]))
      .pipe(
        Effect.mapError((cause) => new PreparationError({ message: "tar listing failed", cause })),
      );
  }),
  links: Effect.fn("SlimServicesSource.tarLinks")(function* (archivePath) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .string(ChildProcess.make("tar", ["-tvf", archivePath]))
      .pipe(
        Effect.mapError(
          (cause) => new PreparationError({ message: "tar link listing failed", cause }),
        ),
      );
  }),
  extract: Effect.fn("SlimServicesSource.tarExtract")(function* (archivePath, destination) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .exitCode(ChildProcess.make("tar", ["-xf", archivePath, "-C", destination]))
      .pipe(
        Effect.mapError(
          (cause) => new PreparationError({ message: "tar extraction failed", cause }),
        ),
      );
  }),
};
const responseFor = (url: string, headers?: Readonly<Record<string, string>>) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    HttpClient.followRedirects(client).get(url, { headers }),
  ).pipe(
    Effect.flatMap((response) =>
      Effect.gen(function* () {
        if (response.status < 200 || response.status >= 300)
          return yield* new PreparationError({
            message: `HTTP ${response.status}`,
            status: response.status,
          });
        return response;
      }),
    ),
  );

/**
 * Release hosts answer rate limits, gateway errors, and dropped transfers that a later attempt
 * resolves. A transfer cut mid-body surfaces as `DecodeError`, so it retries alongside connect
 * failures, while deterministic request faults fail on the first attempt.
 */
const transferFault = (error: unknown): boolean =>
  error instanceof PreparationError
    ? error.status !== undefined &&
      (error.status === 408 || error.status === 429 || error.status >= 500)
    : HttpClientError.isHttpClientError(error) &&
      (error.reason._tag === "TransportError" || error.reason._tag === "DecodeError");

/** 4 retries (5 attempts) per request: 500ms exponential, jittered. */
const TRANSFER_MAX_RETRIES = 4;

const transferBackoff = Schedule.exponential("500 millis").pipe(Schedule.jittered);

const withTransferRetry =
  (url: string, backoff: Schedule.Schedule<unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.tapError((cause) =>
        transferFault(cause)
          ? Effect.logWarning(`Retrying slim-services transfer of ${url}`, cause)
          : Effect.void,
      ),
      Effect.retry({ schedule: backoff, times: TRANSFER_MAX_RETRIES, while: transferFault }),
    );

const fetchBytes = Effect.fn("SlimServicesSource.fetchBytes")(function* (
  url: string,
  backoff: Schedule.Schedule<unknown>,
  headers?: Readonly<Record<string, string>>,
) {
  return yield* responseFor(url, headers).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((bytes) => new Uint8Array(bytes)),
    withTransferRetry(url, backoff),
    Effect.mapError(
      (cause) => new PreparationError({ message: `Unable to download ${url}`, cause }),
    ),
  );
});

const nodeZstdDecompressor: ZstdDecompressor = {
  decompress: Effect.fn("SlimServicesSource.decompress")(function* (
    compressedPath: string,
    outputPath: string,
  ) {
    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.stream(compressedPath).pipe(
        NodeStream.pipeThroughDuplex({
          evaluate: () => createZstdDecompress(),
          onError: (cause) =>
            new PreparationError({
              message: "Unable to decompress slim-services archive",
              cause,
            }),
        }),
        Stream.run(fs.sink(outputPath, { mode: 0o600 })),
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new PreparationError({
            message: "Unable to decompress slim-services archive",
            cause,
          }),
      ),
    );
  }),
};

const downloadToFile = Effect.fn("SlimServicesSource.downloadToFile")(function* (
  url: string,
  destination: string,
  expectedSha256: string,
  backoff: Schedule.Schedule<unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  // Each attempt reopens the sink in truncating mode, so a retry replaces any partial transfer.
  const transfer = Effect.gen(function* () {
    const response = yield* responseFor(url);
    const hash = yield* Effect.try({
      try: () => createHash("sha256"),
      catch: (cause) =>
        new PreparationError({ message: "Unable to initialize archive digest", cause }),
    });
    yield* response.stream.pipe(
      Stream.tap((chunk) =>
        Effect.try({
          try: () => {
            hash.update(chunk);
          },
          catch: (cause) => new PreparationError({ message: "Unable to hash archive", cause }),
        }),
      ),
      Stream.run(fs.sink(destination, { mode: 0o600 })),
    );
    return yield* Effect.try({
      try: () => hash.digest("hex"),
      catch: (cause) => new PreparationError({ message: "Unable to finish archive digest", cause }),
    });
  });
  const actual = yield* transfer.pipe(withTransferRetry(url, backoff));
  if (actual !== expectedSha256.toLowerCase())
    return yield* new PreparationError({
      message: `expected ${expectedSha256}, got ${actual}`,
    });
});

/**
 * Runs `attempt` against each candidate until one succeeds. Fallback failures are not surfaced:
 * when every candidate fails, the error is the primary's. Mixing hosts across the checksum and
 * materialize phases is safe because an archive is only accepted when it hashes to the checksum.
 */
const firstSuccess = <T, A, R>(
  candidates: readonly [T, ...ReadonlyArray<T>],
  describe: (candidate: T) => string,
  attempt: (candidate: T) => Effect.Effect<A, PreparationError, R>,
): Effect.Effect<A, PreparationError, R> => {
  const [primary, ...fallbacks] = candidates;
  const fallback = (
    primaryError: PreparationError,
    remaining: ReadonlyArray<T>,
  ): Effect.Effect<A, PreparationError, R> => {
    const [candidate, ...rest] = remaining;
    if (candidate === undefined) return Effect.fail(primaryError);
    return attempt(candidate).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug(`Slim-services fallback ${describe(candidate)} failed`, cause),
      ),
      Effect.catch(() => fallback(primaryError, rest)),
    );
  };
  return attempt(primary).pipe(Effect.catch((primaryError) => fallback(primaryError, fallbacks)));
};

const checksumFor = (contents: string, archiveName: string): string | undefined =>
  contents
    .split(/\r?\n/u)
    .map((line) => line.trim().match(/^([a-f0-9]{64})\s+[* ]?(.+)$/iu))
    .find((match) => match?.[2] === archiveName || match?.[2]?.endsWith(`/${archiveName}`))?.[1];

const ARCHIVE_MEDIA_TYPE = "application/vnd.supabase.slim.archive.v1.tar+zstd";

const RegistryToken = Schema.Struct({ token: Schema.String });

const NativeOciManifest = Schema.Struct({
  layers: Schema.Array(Schema.Struct({ mediaType: Schema.String, digest: Schema.String })),
});

const decodeJson = <S extends Schema.Top>(schema: S, bytes: Uint8Array, message: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes)).pipe(
    Effect.mapError((cause) => new PreparationError({ message, cause })),
  );

/** Reads the archive layer digest of a native OCI artifact through an anonymous pull token. */
const ociArchiveDigest = Effect.fn("SlimServicesSource.ociArchiveDigest")(function* (
  source: Extract<SlimServicesChecksumSource, { readonly kind: "oci" }>,
  backoff: Schedule.Schedule<unknown>,
) {
  const tokenUrl = `https://${source.registry}/token?scope=repository:${source.repository}:pull&service=${source.registry}`;
  const { token } = yield* decodeJson(
    RegistryToken,
    yield* fetchBytes(tokenUrl, backoff),
    "Slim-services registry token is invalid",
  );
  const manifest = yield* decodeJson(
    NativeOciManifest,
    yield* fetchBytes(
      `https://${source.registry}/v2/${source.repository}/manifests/${source.tag}`,
      backoff,
      {
        accept: "application/vnd.oci.image.manifest.v1+json",
        authorization: `Bearer ${token}`,
      },
    ),
    "Slim-services native OCI manifest is invalid",
  );
  const digest = manifest.layers
    .find((layer) => layer.mediaType === ARCHIVE_MEDIA_TYPE)
    ?.digest.match(/^sha256:([a-f0-9]{64})$/u)?.[1];
  if (digest === undefined)
    return yield* new PreparationError({
      message: "Slim-services native OCI manifest has no archive layer",
    });
  return digest;
});

const describeChecksumSource = (source: SlimServicesChecksumSource): string =>
  source.kind === "sha256sums"
    ? source.url
    : `${source.registry}/${source.repository}:${source.tag}`;

export const slimServicesChecksum = Effect.fn("SlimServicesSource.checksum")(function* (
  artifact: SlimServicesArtifact,
  backoff: Schedule.Schedule<unknown> = transferBackoff,
) {
  return yield* firstSuccess(artifact.checksums, describeChecksumSource, (source) =>
    source.kind === "oci"
      ? ociArchiveDigest(source, backoff)
      : fetchBytes(source.url, backoff).pipe(
          Effect.map((bytes) => new TextDecoder().decode(bytes)),
          Effect.flatMap((contents) => {
            const checksum = checksumFor(contents, `${artifact.assetName}.tar.zst`);
            return checksum === undefined || !/^[a-f0-9]{64}$/iu.test(checksum)
              ? Effect.fail(
                  new PreparationError({
                    message: "Slim-services checksum is missing",
                    service: artifact.service,
                    version: artifact.version,
                  }),
                )
              : Effect.succeed(checksum.toLowerCase());
          }),
        ),
  );
});

const manifestSchema = Schema.Struct({
  service: Schema.String,
  version: Schema.String,
  target: Schema.Literals(["darwin-arm64", "linux-amd64", "linux-arm64"]),
  entrypoint: Schema.optionalKey(Schema.Array(Schema.String)),
  cmd: Schema.optionalKey(Schema.Array(Schema.String)),
});

const verifiedManifest = Effect.fn("SlimServicesSource.verifiedManifest")(function* (
  artifact: SlimServicesArtifact,
  mirror: SlimServicesMirror,
  backoff: Schedule.Schedule<unknown>,
) {
  const manifestBytes = yield* fetchBytes(mirror.manifestUrl, backoff);
  const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(manifestSchema))(
    new TextDecoder().decode(manifestBytes),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new PreparationError({
          message: "Slim-services manifest is invalid",
          cause,
        }),
    ),
  );
  if (
    manifest.service !== artifact.service ||
    manifest.version !== artifact.version ||
    manifest.target !== artifact.target
  )
    return yield* new PreparationError({
      message: "Slim-services manifest does not match the catalog artifact",
      service: artifact.service,
      version: artifact.version,
      target: artifact.target,
    });
  if (
    (manifest.entrypoint !== undefined && manifest.entrypoint.some(unsafeManifestCommand)) ||
    (manifest.cmd !== undefined && manifest.cmd.some(unsafeManifestCommand))
  )
    return yield* new PreparationError({
      message: "Slim-services manifest command is invalid",
      service: artifact.service,
      version: artifact.version,
    });
});

const unsafeArchivePath = (value: string): boolean => {
  const normalized = value.trim();
  if (normalized.length === 0) return false;
  if (normalized.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(normalized)) return true;
  let depth = 0;
  for (const segment of normalized.split(/[\\/]/u)) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (depth === 0) return true;
      depth -= 1;
    } else depth += 1;
  }
  return false;
};

const pathEscapesRoot = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`);
};

const archiveLinkEscapes = (member: string, target: string): boolean => {
  if (target.trim().startsWith("/") || /^[A-Za-z]:[\\/]/u.test(target.trim())) return true;
  const depth =
    member
      .trim()
      .split(/[\\/]/u)
      .filter((segment) => segment.length > 0 && segment !== ".").length - 1;
  let remaining = Math.max(0, depth);
  for (const segment of target.trim().split(/[\\/]/u)) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (remaining === 0) return true;
      remaining -= 1;
    } else remaining += 1;
  }
  return false;
};

const unsafeManifestCommand = (value: string): boolean =>
  value.split(/[\\/]/u).some((segment) => segment === "..");

const validateExtractedTree = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  destination: string,
): Effect.Effect<void, PreparationError> =>
  Effect.gen(function* () {
    const root = yield* fs.realPath(destination);
    const entries = yield* fs.readDirectory(destination, { recursive: true });
    for (const entry of entries) {
      const candidate = path.join(destination, entry);
      const resolved = yield* fs.realPath(candidate);
      if (pathEscapesRoot(path, root, resolved))
        return yield* new PreparationError({
          message: "Slim-services archive entry escapes its staging directory",
          path: entry,
        });
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof PreparationError
        ? error
        : new PreparationError({
            message: "Unable to validate extracted slim-services archive",
            cause: error,
          }),
    ),
  );

export const makeSlimServicesSource = (
  resolve: (request: ArtifactRequest) => SlimServicesArtifact | undefined,
  overrides: {
    readonly tarBoundary?: TarBoundary;
    readonly decompressor?: ZstdDecompressor;
    readonly backoff?: Schedule.Schedule<unknown>;
  } = {},
): ArtifactSource => {
  const tarBoundary = overrides.tarBoundary ?? systemTarBoundary;
  const decompressor = overrides.decompressor ?? nodeZstdDecompressor;
  const backoff = overrides.backoff ?? transferBackoff;
  const resolveArtifact = Effect.fn("SlimServicesSource.resolveArtifact")(function* (
    request: ArtifactRequest,
  ) {
    const artifact = resolve(request);
    if (artifact === undefined)
      return yield* new PreparationError({ message: `No slim-services source for ${request.key}` });
    return artifact;
  });
  return {
    checksum: (request) =>
      resolveArtifact(request).pipe(
        Effect.flatMap((artifact) => slimServicesChecksum(artifact, backoff)),
      ),
    materialize: Effect.fn("SlimServicesSource.materialize")(
      function* (request, destination, expectedSha256, onProgress) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const compressedPath = path.join(destination, ".slim-services.tar.zst");
        const archivePath = path.join(destination, ".slim-services.tar");
        const cleanup = Effect.all([
          fs.remove(compressedPath, { force: true }).pipe(Effect.ignore),
          fs.remove(archivePath, { force: true }).pipe(Effect.ignore),
        ]);
        return yield* Effect.gen(function* () {
          const artifact = yield* resolveArtifact(request);
          yield* firstSuccess(
            artifact.mirrors,
            (mirror) => mirror.downloadUrl,
            (mirror) =>
              verifiedManifest(artifact, mirror, backoff).pipe(
                Effect.andThen(
                  Effect.sync(() => onProgress?.("downloading")).pipe(
                    Effect.andThen(
                      downloadToFile(mirror.downloadUrl, compressedPath, expectedSha256, backoff),
                    ),
                    Effect.mapError(
                      (cause) =>
                        new PreparationError({
                          message: "Unable to download slim-services archive",
                          service: artifact.service,
                          version: artifact.version,
                          cause,
                        }),
                    ),
                  ),
                ),
              ),
          );
          yield* Effect.sync(() => onProgress?.("preparing"));
          yield* decompressor.decompress(compressedPath, archivePath);
          const members = yield* tarBoundary.list(archivePath).pipe(
            Effect.mapError(
              (cause) =>
                new PreparationError({
                  message: "Unable to list slim-services archive",
                  cause,
                }),
            ),
          );
          const unsafeMember = members
            .split(/\r?\n/u)
            .map((member) => member.trim())
            .find(unsafeArchivePath);
          if (unsafeMember !== undefined)
            return yield* new PreparationError({
              message: "Slim-services archive contains an unsafe path",
              path: unsafeMember,
            });
          const links = yield* tarBoundary.links(archivePath).pipe(
            Effect.mapError(
              (cause) =>
                new PreparationError({
                  message: "Unable to inspect slim-services archive links",
                  cause,
                }),
            ),
          );
          const unsafeLink = links
            .split(/\r?\n/u)
            .map((line) => {
              const arrow = line.indexOf(" -> ");
              const hardLink = line.indexOf(" link to ");
              const marker = arrow >= 0 ? arrow : hardLink;
              if (marker < 0) return undefined;
              const member = line.slice(0, marker).trim().split(/\s+/u).at(-1) ?? "";
              const target = line.slice(marker + (arrow >= 0 ? 4 : 9)).trim();
              return archiveLinkEscapes(member, target) ? target : undefined;
            })
            .find((target): target is string => target !== undefined);
          if (unsafeLink !== undefined)
            return yield* new PreparationError({
              message: "Slim-services archive contains an unsafe link target",
              path: unsafeLink,
            });
          const exitCode = yield* tarBoundary.extract(archivePath, destination).pipe(
            Effect.mapError(
              (cause) =>
                new PreparationError({
                  message: "Unable to extract slim-services archive",
                  cause,
                }),
            ),
          );
          if (exitCode !== 0)
            return yield* new PreparationError({
              message: `Slim-services archive extraction exited with code ${exitCode}`,
            });
          yield* validateExtractedTree(fs, path, destination);
        }).pipe(Effect.ensuring(cleanup));
      },
    ),
  };
};
