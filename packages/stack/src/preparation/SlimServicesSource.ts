import { Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { NodeStream } from "@effect/platform-node";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "effect/unstable/http";
import { createZstdDecompress } from "node:zlib";
import { createHash } from "node:crypto";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ArtifactRequest, ArtifactSource } from "./ArtifactStore.ts";
import type { NativeWorkloadArtifact } from "../model/WorkloadCatalog.ts";
import { StackPreparationError } from "../public/Errors.ts";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface ZstdDecompressor {
  readonly decompress: (
    compressedPath: string,
    outputPath: string,
  ) => Effect.Effect<void, StackPreparationError, FileSystem.FileSystem>;
}

export interface TarBoundary {
  readonly list: (
    archivePath: string,
  ) => Effect.Effect<string, StackPreparationError, ChildProcessSpawner.ChildProcessSpawner>;
  readonly links: (
    archivePath: string,
  ) => Effect.Effect<string, StackPreparationError, ChildProcessSpawner.ChildProcessSpawner>;
  readonly extract: (
    archivePath: string,
    destination: string,
  ) => Effect.Effect<number, StackPreparationError, ChildProcessSpawner.ChildProcessSpawner>;
}

/** The system tar boundary is argv-based so archive paths never enter a shell string. */
export const systemTarBoundary: TarBoundary = {
  list: (archivePath) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return yield* spawner
        .string(ChildProcess.make("tar", ["-tf", archivePath]))
        .pipe(
          Effect.mapError(
            (cause) => new StackPreparationError({ message: "tar listing failed", cause }),
          ),
        );
    }),
  links: (archivePath) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return yield* spawner
        .string(ChildProcess.make("tar", ["-tvf", archivePath]))
        .pipe(
          Effect.mapError(
            (cause) => new StackPreparationError({ message: "tar link listing failed", cause }),
          ),
        );
    }),
  extract: (archivePath, destination) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return yield* spawner
        .exitCode(ChildProcess.make("tar", ["-xf", archivePath, "-C", destination]))
        .pipe(
          Effect.mapError(
            (cause) => new StackPreparationError({ message: "tar extraction failed", cause }),
          ),
        );
    }),
};
const transport = (fetchRequest?: Fetcher) =>
  fetchRequest === undefined
    ? FetchHttpClient.layer
    : Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request, url, signal) =>
          Effect.tryPromise({
            try: () =>
              fetchRequest(url.href, { signal, method: request.method, headers: request.headers }),
            catch: (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause }),
              }),
          }).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
        ),
      );

const responseFor = (url: string) =>
  HttpClient.get(url).pipe(
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
  request?: Fetcher,
): Effect.Effect<Uint8Array, StackPreparationError> =>
  responseFor(url).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((bytes) => new Uint8Array(bytes)),
    Effect.mapError(
      (cause) => new StackPreparationError({ message: `Unable to download ${url}`, cause }),
    ),
    Effect.provide(transport(request)),
  );

const nodeZstdDecompressor: ZstdDecompressor = {
  decompress: (compressedPath, outputPath) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.stream(compressedPath).pipe(
        NodeStream.pipeThroughDuplex({
          evaluate: () => createZstdDecompress(),
          onError: (cause) =>
            new StackPreparationError({
              message: "Unable to decompress slim-services archive",
              cause,
            }),
        }),
        Stream.run(fs.sink(outputPath, { mode: 0o600 })),
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new StackPreparationError({
            message: "Unable to decompress slim-services archive",
            cause,
          }),
      ),
    ),
};

const downloadToFile = (
  url: string,
  destination: string,
  request: Fetcher | undefined,
  expectedSha256: string,
): Effect.Effect<void, StackPreparationError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const response = yield* responseFor(url);
    const hash = yield* Effect.try({
      try: () => createHash("sha256"),
      catch: (cause) =>
        new StackPreparationError({ message: "Unable to initialize archive digest", cause }),
    });
    yield* response.stream.pipe(
      Stream.tap((chunk) =>
        Effect.try({
          try: () => {
            hash.update(chunk);
          },
          catch: (cause) => new StackPreparationError({ message: "Unable to hash archive", cause }),
        }),
      ),
      Stream.run(fs.sink(destination, { mode: 0o600 })),
    );
    const actual = yield* Effect.try({
      try: () => hash.digest("hex"),
      catch: (cause) =>
        new StackPreparationError({ message: "Unable to finish archive digest", cause }),
    });
    if (actual !== expectedSha256.toLowerCase())
      return yield* new StackPreparationError({
        message: `expected ${expectedSha256}, got ${actual}`,
      });
  }).pipe(
    Effect.mapError(
      (cause) => new StackPreparationError({ message: `Unable to download ${url}`, cause }),
    ),
    Effect.provide(transport(request)),
  );

const checksumFor = (contents: string, archiveName: string): string | undefined =>
  contents
    .split(/\r?\n/u)
    .map((line) => line.trim().match(/^([a-f0-9]{64})\s+[* ]?(.+)$/iu))
    .find((match) => match?.[2] === archiveName || match?.[2]?.endsWith(`/${archiveName}`))?.[1];

export const slimServicesChecksum = (
  artifact: NativeWorkloadArtifact,
  request?: Fetcher,
): Effect.Effect<string, StackPreparationError> =>
  fetchBytes(artifact.checksumUrl, request).pipe(
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
    Effect.flatMap((contents) => {
      const checksum = checksumFor(contents, `${artifact.assetName}.tar.zst`);
      return checksum === undefined || !/^[a-f0-9]{64}$/iu.test(checksum)
        ? Effect.fail(
            new StackPreparationError({
              message: "Slim-services checksum is missing",
              service: artifact.service,
              version: artifact.version,
            }),
          )
        : Effect.succeed(checksum.toLowerCase());
    }),
  );

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
): Effect.Effect<void, StackPreparationError> =>
  Effect.gen(function* () {
    const root = yield* fs.realPath(destination);
    const entries = yield* fs.readDirectory(destination, { recursive: true });
    for (const entry of entries) {
      const candidate = path.join(destination, entry);
      const resolved = yield* fs.realPath(candidate);
      if (pathEscapesRoot(path, root, resolved))
        return yield* new StackPreparationError({
          message: "Slim-services archive entry escapes its staging directory",
          path: entry,
        });
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof StackPreparationError
        ? error
        : new StackPreparationError({
            message: "Unable to validate extracted slim-services archive",
            cause: error,
          }),
    ),
  );

export const makeSlimServicesSource = (
  resolve: (request: ArtifactRequest) => NativeWorkloadArtifact | undefined,
  fetchRequest?: Fetcher,
  tarBoundary: TarBoundary = systemTarBoundary,
  decompressor: ZstdDecompressor = nodeZstdDecompressor,
): ArtifactSource => {
  const resolveArtifact = (
    request: ArtifactRequest,
  ): Effect.Effect<NativeWorkloadArtifact, StackPreparationError> => {
    const artifact = resolve(request);
    if (artifact === undefined)
      return Effect.fail(
        new StackPreparationError({ message: `No slim-services source for ${request.key}` }),
      );
    return Effect.succeed(artifact);
  };
  return {
    checksum: (request) =>
      resolveArtifact(request).pipe(
        Effect.flatMap((artifact) => slimServicesChecksum(artifact, fetchRequest)),
      ),
    materialize: (request, destination, expectedSha256, onProgress) =>
      Effect.gen(function* () {
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
          const manifestBytes = yield* fetchBytes(artifact.manifestUrl, fetchRequest);
          const manifestText = new TextDecoder().decode(manifestBytes);
          const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
            manifestText,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new StackPreparationError({
                  message: "Slim-services manifest is invalid",
                  cause,
                }),
            ),
          );
          if (
            typeof manifest !== "object" ||
            manifest === null ||
            !("service" in manifest) ||
            !("version" in manifest) ||
            !("target" in manifest) ||
            manifest.service !== artifact.service ||
            manifest.version !== artifact.version ||
            manifest.target !== artifact.target
          )
            return yield* new StackPreparationError({
              message: "Slim-services manifest does not match the catalog artifact",
              service: artifact.service,
              version: artifact.version,
              target: artifact.target,
            });
          const entrypoint = "entrypoint" in manifest ? manifest.entrypoint : undefined;
          const command = "cmd" in manifest ? manifest.cmd : undefined;
          if (
            (entrypoint !== undefined &&
              (!Array.isArray(entrypoint) ||
                !entrypoint.every((value) => typeof value === "string") ||
                entrypoint.some(unsafeManifestCommand))) ||
            (command !== undefined &&
              (!Array.isArray(command) ||
                !command.every((value) => typeof value === "string") ||
                command.some(unsafeManifestCommand)))
          )
            return yield* new StackPreparationError({
              message: "Slim-services manifest command is invalid",
              service: artifact.service,
              version: artifact.version,
            });
          yield* Effect.sync(() => onProgress?.("downloading")).pipe(
            Effect.andThen(
              downloadToFile(artifact.downloadUrl, compressedPath, fetchRequest, expectedSha256),
            ),
            Effect.mapError(
              (cause) =>
                new StackPreparationError({
                  message: "Unable to download slim-services archive",
                  service: artifact.service,
                  version: artifact.version,
                  cause,
                }),
            ),
          );
          yield* Effect.sync(() => onProgress?.("preparing"));
          yield* decompressor.decompress(compressedPath, archivePath);
          const members = yield* tarBoundary.list(archivePath).pipe(
            Effect.mapError(
              (cause) =>
                new StackPreparationError({
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
            return yield* new StackPreparationError({
              message: "Slim-services archive contains an unsafe path",
              path: unsafeMember,
            });
          const links = yield* tarBoundary.links(archivePath).pipe(
            Effect.mapError(
              (cause) =>
                new StackPreparationError({
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
            return yield* new StackPreparationError({
              message: "Slim-services archive contains an unsafe link target",
              path: unsafeLink,
            });
          const exitCode = yield* tarBoundary.extract(archivePath, destination).pipe(
            Effect.mapError(
              (cause) =>
                new StackPreparationError({
                  message: "Unable to extract slim-services archive",
                  cause,
                }),
            ),
          );
          if (exitCode !== 0)
            return yield* new StackPreparationError({
              message: `Slim-services archive extraction exited with code ${exitCode}`,
            });
          yield* validateExtractedTree(fs, path, destination);
        }).pipe(Effect.ensuring(cleanup));
      }),
  };
};
