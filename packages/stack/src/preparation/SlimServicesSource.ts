import { Effect, FileSystem, Path, Schema } from "effect";
import { createZstdDecompress } from "node:zlib";
import { createHash } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- file-backed streaming avoids archive-sized buffers
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ArtifactRequest, ArtifactSource } from "./ArtifactStore.ts";
import type { NativeWorkloadArtifact } from "../model/WorkloadCatalog.ts";
import { StackPreparationError } from "../public/Errors.ts";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface ZstdDecompressor {
  readonly decompress: (
    compressedPath: string,
    outputPath: string,
  ) => Effect.Effect<void, StackPreparationError>;
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
// oxlint-disable-next-line effecttsgo/global-fetch -- foreign HTTP boundary; production wiring may swap in an Effect HttpClient-backed fetcher.
const fetcher: Fetcher = (input, init) => globalThis.fetch(input, init);

const fetchBytes = (
  url: string,
  request: Fetcher = fetcher,
): Effect.Effect<Uint8Array, StackPreparationError> =>
  Effect.tryPromise({
    try: (signal) =>
      request(url, { signal })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.arrayBuffer();
        })
        .then((bytes) => new Uint8Array(bytes)),
    catch: (cause) => new StackPreparationError({ message: `Unable to download ${url}`, cause }),
  });

/** Owned streaming zstd boundary. Cancellation aborts and awaits the exact pipeline. */
const nodeZstdDecompressor: ZstdDecompressor = {
  decompress: (compressedPath, outputPath) =>
    Effect.callback<void, StackPreparationError>((resume) => {
      const controller = new AbortController();
      const operation = pipeline(
        createReadStream(compressedPath),
        createZstdDecompress(),
        createWriteStream(outputPath, { mode: 0o600 }),
        { signal: controller.signal },
      );
      void operation.then(
        () => resume(Effect.void),
        (cause) =>
          resume(
            Effect.fail(
              new StackPreparationError({
                message: "Unable to decompress slim-services archive",
                cause,
              }),
            ),
          ),
      );
      return Effect.gen(function* () {
        controller.abort();
        yield* Effect.promise(() =>
          operation.then(
            () => undefined,
            () => undefined,
          ),
        );
      });
    }),
};

const downloadToFile = (
  url: string,
  destination: string,
  request: Fetcher,
  expectedSha256: string,
): Effect.Effect<void, StackPreparationError> =>
  Effect.callback<void, StackPreparationError>((resume) => {
    const controller = new AbortController();
    // oxlint-disable-next-line effecttsgo/async-function -- foreign pipeline must settle before cancellation cleanup
    const operation = (async () => {
      const response = await request(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (response.body === null) throw new Error("Response body is empty");
      const source = Readable.fromWeb(response.body);
      const hash = createHash("sha256");
      const digest = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(source, digest, createWriteStream(destination, { mode: 0o600 }), {
        signal: controller.signal,
      });
      const actual = hash.digest("hex");
      if (actual !== expectedSha256.toLowerCase())
        throw new Error(`expected ${expectedSha256}, got ${actual}`);
    })();
    const failure = (cause: unknown) =>
      resume(
        Effect.fail(new StackPreparationError({ message: `Unable to download ${url}`, cause })),
      );
    void operation.then(() => resume(Effect.void), failure);
    return Effect.gen(function* () {
      controller.abort();
      yield* Effect.promise(() =>
        operation.then(
          () => undefined,
          () => undefined,
        ),
      );
    });
  });

const checksumFor = (contents: string, archiveName: string): string | undefined =>
  contents
    .split(/\r?\n/u)
    .map((line) => line.trim().match(/^([a-f0-9]{64})\s+[* ]?(.+)$/iu))
    .find((match) => match?.[2] === archiveName || match?.[2]?.endsWith(`/${archiveName}`))?.[1];

export const slimServicesChecksum = (
  artifact: NativeWorkloadArtifact,
  request: Fetcher = fetcher,
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
  fetchRequest: Fetcher = fetcher,
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
