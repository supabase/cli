import { Crypto, Effect, FileSystem, Path, Schema } from "effect";
import { createZstdDecompress } from "node:zlib";
import type { Transform } from "node:stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ArtifactRequest, ArtifactSource } from "./ArtifactStore.ts";
import type { NativeWorkloadArtifact } from "../model/WorkloadCatalog.ts";
import { StackPreparationError } from "../public/Errors.ts";
import { verifySha256 } from "./Integrity.ts";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface ZstdDecompressor {
  readonly decompress: (bytes: Uint8Array) => Effect.Effect<Uint8Array, StackPreparationError>;
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
// The slim-services transport is a foreign HTTP boundary; production wiring
// may provide an Effect HttpClient-backed fetcher through RuntimeFactory.
// oxlint-disable-next-line effecttsgo/global-fetch
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

/** Owned streaming zstd boundary. Cancellation destroys the exact transform. */
const nodeZstdDecompressor: ZstdDecompressor = {
  decompress: (bytes) =>
    Effect.callback<Uint8Array, StackPreparationError>((resume) => {
      const transform: Transform = createZstdDecompress();
      const chunks: Uint8Array[] = [];
      let done = false;
      const cleanup = () => {
        transform.removeListener("data", onData);
        transform.removeListener("error", onError);
        transform.removeListener("end", onEnd);
      };
      const complete = (effect: Effect.Effect<Uint8Array, StackPreparationError>) => {
        if (done) return;
        done = true;
        cleanup();
        resume(effect);
      };
      const onData = (chunk: Uint8Array) => chunks.push(new Uint8Array(chunk));
      const onError = (cause: unknown) =>
        complete(
          Effect.fail(
            new StackPreparationError({
              message: "Unable to decompress slim-services archive",
              cause,
            }),
          ),
        );
      const onEnd = () => {
        const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
        const output = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          output.set(chunk, offset);
          offset += chunk.length;
        }
        complete(Effect.succeed(output));
      };
      transform.on("data", onData);
      transform.once("error", onError);
      transform.once("end", onEnd);
      transform.end(bytes);
      return Effect.sync(() => {
        if (done) return;
        done = true;
        cleanup();
        transform.destroy();
      });
    }),
};

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

/**
 * Postgres slim archives keep init scripts below `migrations/`. Older archives
 * may also contain a real historical sibling directory, which would make the
 * native init script run every migration twice. Remove only that exact sibling
 * path so the native archive has the same layout as the container image.
 */
export const normalizeSlimServicesLayout = (
  artifact: NativeWorkloadArtifact,
  destination: string,
): Effect.Effect<void, StackPreparationError, FileSystem.FileSystem | Path.Path> => {
  if (artifact.service !== "postgres") return Effect.void;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = (candidate: string): Effect.Effect<boolean, StackPreparationError> =>
      fs.exists(candidate).pipe(
        Effect.mapError(
          (cause) =>
            new StackPreparationError({
              message: "Unable to inspect Postgres slim init-scripts layout",
              path: candidate,
              cause,
            }),
        ),
      );
    const target = path.join(destination, "share/supabase-cli/migrations/init-scripts");
    const alias = path.join(destination, "share/supabase-cli/init-scripts");
    const targetExists = yield* exists(target);
    if (!targetExists)
      return yield* new StackPreparationError({
        message: "Postgres slim artifact is missing its init-scripts directory",
        path: "share/supabase-cli/migrations/init-scripts",
      });
    const aliasExists = yield* exists(alias);
    if (!aliasExists) return;
    const root = yield* fs.realPath(destination).pipe(
      Effect.mapError(
        (cause) =>
          new StackPreparationError({
            message: "Unable to inspect Postgres slim artifact root",
            cause,
          }),
      ),
    );
    const realAlias = yield* fs.realPath(alias).pipe(
      Effect.mapError(
        (cause) =>
          new StackPreparationError({
            message: "Unable to validate Postgres slim init-scripts layout",
            cause,
          }),
      ),
    );
    if (pathEscapesRoot(path, root, realAlias))
      return yield* new StackPreparationError({
        message: "Postgres slim init-scripts alias resolves outside its artifact root",
      });
    yield* fs.remove(alias, { recursive: true, force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new StackPreparationError({
            message: "Unable to remove Postgres slim init-scripts alias",
            cause,
          }),
      ),
    );
  });
};

export const makeSlimServicesSource = (
  resolve: (request: ArtifactRequest) => NativeWorkloadArtifact | undefined,
  fetchRequest: Fetcher = fetcher,
  tarBoundary: TarBoundary = systemTarBoundary,
  decompressor: ZstdDecompressor = nodeZstdDecompressor,
): ArtifactSource => ({
  materialize: (request, destination) => {
    const artifact = resolve(request);
    if (artifact === undefined)
      return Effect.fail(
        new StackPreparationError({ message: `No slim-services source for ${request.key}` }),
      );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const manifestBytes = yield* fetchBytes(artifact.manifestUrl, fetchRequest);
      const manifestText = new TextDecoder().decode(manifestBytes);
      const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        manifestText,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new StackPreparationError({ message: "Slim-services manifest is invalid", cause }),
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
      const listedChecksum = yield* slimServicesChecksum(artifact, fetchRequest);
      if (listedChecksum !== request.sha256.toLowerCase())
        return yield* new StackPreparationError({
          message: "Slim-services checksum does not match the artifact request",
          service: artifact.service,
          version: artifact.version,
        });
      const compressed = yield* fetchBytes(artifact.downloadUrl, fetchRequest);
      const crypto = yield* Crypto.Crypto;
      yield* verifySha256(compressed, request.sha256).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError(
          (cause) =>
            new StackPreparationError({
              message: "Slim-services archive digest does not match the artifact request",
              service: artifact.service,
              version: artifact.version,
              cause,
            }),
        ),
      );
      const archive = yield* decompressor.decompress(compressed);
      const archivePath = path.join(destination, ".slim-services.tar");
      yield* fs.writeFile(archivePath, archive).pipe(
        Effect.mapError(
          (cause) =>
            new StackPreparationError({
              message: "Unable to stage slim-services archive",
              cause,
            }),
        ),
      );
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
      yield* normalizeSlimServicesLayout(artifact, destination);
      yield* validateExtractedTree(fs, path, destination);
      yield* fs.remove(archivePath, { force: true }).pipe(Effect.ignore);
      return compressed;
    });
  },
});
