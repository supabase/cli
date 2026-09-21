import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { NodeStream } from "@effect/platform-node";
import { HttpClient } from "effect/unstable/http";
import { createZstdDecompress } from "node:zlib";
import { createHash } from "node:crypto";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ArtifactRequest, ArtifactSource } from "./ArtifactStore.ts";
import { PreparationError } from "./Errors.ts";

export interface SlimServicesArtifact {
  readonly provider: "supabase/slim-services";
  readonly service: string;
  readonly version: string;
  readonly releaseTag: string;
  readonly target: "darwin-arm64" | "linux-amd64" | "linux-arm64";
  readonly archive: "tar.zst";
  readonly assetName: string;
  readonly downloadUrl: string;
  readonly manifestUrl: string;
  readonly checksumUrl: string;
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
export const systemTarBoundary: TarBoundary = {
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
const responseFor = (url: string) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    HttpClient.followRedirects(client).get(url),
  ).pipe(
    Effect.flatMap((response) =>
      Effect.gen(function* () {
        if (response.status < 200 || response.status >= 300)
          return yield* new PreparationError({ message: `HTTP ${response.status}` });
        return response;
      }),
    ),
  );

const fetchBytes = Effect.fn("SlimServicesSource.fetchBytes")(function* (url: string) {
  return yield* responseFor(url).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((bytes) => new Uint8Array(bytes)),
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
) {
  const fs = yield* FileSystem.FileSystem;
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
  const actual = yield* Effect.try({
    try: () => hash.digest("hex"),
    catch: (cause) => new PreparationError({ message: "Unable to finish archive digest", cause }),
  });
  if (actual !== expectedSha256.toLowerCase())
    return yield* new PreparationError({
      message: `expected ${expectedSha256}, got ${actual}`,
    });
});

const checksumFor = (contents: string, archiveName: string): string | undefined =>
  contents
    .split(/\r?\n/u)
    .map((line) => line.trim().match(/^([a-f0-9]{64})\s+[* ]?(.+)$/iu))
    .find((match) => match?.[2] === archiveName || match?.[2]?.endsWith(`/${archiveName}`))?.[1];

export const slimServicesChecksum = Effect.fn("SlimServicesSource.checksum")(function* (
  artifact: SlimServicesArtifact,
) {
  return yield* fetchBytes(artifact.checksumUrl).pipe(
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
  );
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
  tarBoundary: TarBoundary = systemTarBoundary,
  decompressor: ZstdDecompressor = nodeZstdDecompressor,
): ArtifactSource => {
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
      resolveArtifact(request).pipe(Effect.flatMap((artifact) => slimServicesChecksum(artifact))),
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
          const manifestBytes = yield* fetchBytes(artifact.manifestUrl);
          const manifestText = new TextDecoder().decode(manifestBytes);
          const manifestSchema = Schema.Struct({
            service: Schema.String,
            version: Schema.String,
            target: Schema.Literals(["darwin-arm64", "linux-amd64", "linux-arm64"]),
            entrypoint: Schema.optionalKey(Schema.Array(Schema.String)),
            cmd: Schema.optionalKey(Schema.Array(Schema.String)),
          });
          const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(manifestSchema))(
            manifestText,
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
          const entrypoint = manifest.entrypoint;
          const command = manifest.cmd;
          if (
            (entrypoint !== undefined && entrypoint.some(unsafeManifestCommand)) ||
            (command !== undefined && command.some(unsafeManifestCommand))
          )
            return yield* new PreparationError({
              message: "Slim-services manifest command is invalid",
              service: artifact.service,
              version: artifact.version,
            });
          yield* Effect.sync(() => onProgress?.("downloading")).pipe(
            Effect.andThen(downloadToFile(artifact.downloadUrl, compressedPath, expectedSha256)),
            Effect.mapError(
              (cause) =>
                new PreparationError({
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
