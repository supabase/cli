import { Effect, FileSystem, Schema } from "effect";
import { zstdDecompress } from "node:zlib";
import type { ArtifactRequest, ArtifactSource } from "./ArtifactStore.ts";
import type { NativeWorkloadArtifact } from "../model/WorkloadCatalog.ts";
import { StackPreparationError } from "../public/Errors.ts";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
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

const decompress = (bytes: Uint8Array): Effect.Effect<Uint8Array, StackPreparationError> =>
  Effect.callback<Uint8Array, StackPreparationError>((resume) => {
    let done = false;
    const complete = (effect: Effect.Effect<Uint8Array, StackPreparationError>) => {
      if (done) return;
      done = true;
      resume(effect);
    };
    try {
      zstdDecompress(bytes, (cause, output) =>
        complete(
          cause === null
            ? Effect.succeed(output)
            : Effect.fail(
                new StackPreparationError({
                  message: "Unable to decompress slim-services archive",
                  cause,
                }),
              ),
        ),
      );
    } catch (cause) {
      complete(
        Effect.fail(
          new StackPreparationError({
            message: "Unable to decompress slim-services archive",
            cause,
          }),
        ),
      );
    }
    return Effect.void;
  });

const checksumFor = (contents: string, archiveName: string): string | undefined =>
  contents
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .find((parts) => parts[1] === archiveName || parts[1]?.endsWith(`/${archiveName}`))?.[0];

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

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).replace(/\0+$/u, "");
const octal = (bytes: Uint8Array): number => Number.parseInt(text(bytes).trim() || "0", 8);

const writeFile = (fs: FileSystem.FileSystem, path: string, bytes: Uint8Array) =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(path, { flag: "wx", mode: 0o700 });
      yield* file.writeAll(bytes);
    }),
  );

const extractTar = (
  fs: FileSystem.FileSystem,
  destination: string,
  archive: Uint8Array,
): Effect.Effect<void, StackPreparationError> =>
  Effect.gen(function* () {
    let offset = 0;
    let pendingPath: string | undefined;
    while (offset + 512 <= archive.length) {
      const header = archive.subarray(offset, offset + 512);
      offset += 512;
      if (header.every((byte) => byte === 0)) break;
      const name = text(header.subarray(0, 100));
      const prefix = text(header.subarray(345, 500));
      const member = pendingPath ?? (prefix.length === 0 ? name : `${prefix}/${name}`);
      const unsafe =
        member.startsWith("/") ||
        member.split("/").some((part) => part === ".." || (part.length === 0 && part !== ""));
      if (unsafe)
        return yield* new StackPreparationError({
          message: "Slim-services archive contains an unsafe path",
          path: member,
        });
      const size = octal(header.subarray(124, 136));
      const type = header[156];
      const target = `${destination}/${member}`;
      if (type === 120 || type === 76) {
        const pax = text(archive.subarray(offset, offset + size));
        pendingPath =
          type === 76
            ? pax
            : pax
                .split(/\n/u)
                .find((record) => record.includes(" path="))
                ?.split(" path=")[1]
                ?.trim();
      } else if (type === 53) {
        yield* fs.makeDirectory(target, { recursive: true, mode: 0o700 });
      } else if (type === 48 || type === 0 || type === undefined) {
        const parent = target.slice(0, target.lastIndexOf("/"));
        yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
        yield* writeFile(fs, target, archive.subarray(offset, offset + size));
      } else {
        return yield* new StackPreparationError({
          message: "Slim-services archive contains an unsupported entry",
          path: member,
        });
      }
      if (type !== 120 && type !== 76) pendingPath = undefined;
      offset += Math.ceil(size / 512) * 512;
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof StackPreparationError
        ? error
        : new StackPreparationError({
            message: "Unable to extract slim-services archive",
            cause: error,
          }),
    ),
  );

export const makeSlimServicesSource = (
  resolve: (request: ArtifactRequest) => NativeWorkloadArtifact | undefined,
  fetchRequest: Fetcher = fetcher,
): ArtifactSource => ({
  materialize: (request, destination) => {
    const artifact = resolve(request);
    if (artifact === undefined)
      return Effect.fail(
        new StackPreparationError({ message: `No slim-services source for ${request.key}` }),
      );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
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
      const compressed = yield* fetchBytes(artifact.downloadUrl, fetchRequest);
      const archive = yield* decompress(compressed);
      yield* extractTar(fs, destination, archive);
      return compressed;
    });
  },
});
