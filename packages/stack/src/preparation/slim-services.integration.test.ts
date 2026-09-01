import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Crypto, Deferred, Effect, Exit, Fiber, FileSystem, Option } from "effect";
import { zstdCompress } from "node:zlib";
import { makeArtifactStore, type ArtifactRequest } from "./ArtifactStore.ts";
import { digestHex } from "./Integrity.ts";
import { StackPreparationError } from "../public/Errors.ts";
import {
  makeSlimServicesSource,
  normalizeSlimServicesLayout,
  slimServicesChecksum,
  systemTarBoundary,
  type ZstdDecompressor,
} from "./SlimServicesSource.ts";
import type { NativeWorkloadArtifact } from "../model/WorkloadCatalog.ts";

const artifact: NativeWorkloadArtifact = {
  provider: "supabase/slim-services",
  service: "demo",
  version: "v1.0.0",
  releaseTag: "demo-v1.0.0",
  target: "linux-amd64",
  archive: "tar.zst",
  assetName: "demo-v1.0.0-linux-amd64",
  downloadUrl: "https://example.test/demo.tar.zst",
  manifestUrl: "https://example.test/demo.manifest.json",
  checksumUrl: "https://example.test/SHA256SUMS",
  requiredRuntimePaths: ["bin/demo"],
  executablePath: "bin/demo",
};
const request: ArtifactRequest = {
  key: "demo/v1",
  sha256: "0".repeat(64),
  requiredRuntimePaths: ["bin/demo"],
  executablePath: "bin/demo",
};

const tarEntries = (
  entries: ReadonlyArray<{
    readonly name: string;
    readonly content?: string;
    readonly link?: string;
    readonly type?: number;
  }>,
): Uint8Array => {
  const blocks = entries.map((entry) => Math.max(1, Math.ceil((entry.content?.length ?? 0) / 512)));
  const bytes = new Uint8Array((1 + blocks.reduce((sum, value) => sum + value, 0) + 2) * 512);
  let offset = 0;
  for (const [index, entry] of entries.entries()) {
    const header = bytes.subarray(offset, offset + 512);
    header.set(new TextEncoder().encode(entry.name), 0);
    header.set(new TextEncoder().encode("0000755\0"), 100);
    header.set(new TextEncoder().encode("0000000\0"), 108);
    header.set(new TextEncoder().encode("0000000\0"), 116);
    const content = entry.content ?? "";
    header.set(new TextEncoder().encode(`${content.length.toString(8).padStart(11, "0")}\0`), 124);
    header[156] = entry.type ?? (entry.link === undefined ? 48 : 50);
    if (entry.link !== undefined) header.set(new TextEncoder().encode(entry.link), 157);
    header.set(new TextEncoder().encode("ustar\0"), 257);
    header.fill(32, 148, 156);
    const checksum = header
      .reduce((sum, value) => sum + value, 0)
      .toString(8)
      .padStart(6, "0");
    header.set(new TextEncoder().encode(`${checksum}\0 `), 148);
    offset += 512;
    if (content.length > 0) {
      bytes.set(new TextEncoder().encode(content), offset);
    }
    offset += (blocks[index] ?? 1) * 512;
  }
  return bytes;
};

const tar = (name: string, content: string): Uint8Array => tarEntries([{ name, content }]);

const paxTar = (name: string): Uint8Array => {
  const raw = `path=${name}\n`;
  let record = `${raw.length + 3} ${raw}`;
  while (
    record.length.toString().length + 1 + raw.length !==
    Number(record.slice(0, record.indexOf(" ")))
  ) {
    record = `${record.length.toString().length + 1 + raw.length} ${raw}`;
  }
  return tarEntries([
    { name: "PaxHeaders.0/x", content: record, type: 120 },
    { name: "x", content: "demo" },
  ]);
};

const compress = (bytes: Uint8Array) =>
  Effect.callback<Uint8Array, Error>((resume) => {
    zstdCompress(bytes, (error, output) =>
      error === null ? resume(Effect.succeed(output)) : resume(Effect.fail(error)),
    );
    return Effect.void;
  });

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;
const requestUrl = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

describe("slim-services artifact source", () => {
  it.live("keeps Postgres init scripts only under the migrations directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({
          prefix: "slim-services-postgres-",
        });
        const initScripts = `${destination}/share/supabase-cli/migrations/init-scripts`;
        yield* fs.makeDirectory(initScripts, { recursive: true });
        const postgresArtifact = { ...artifact, service: "postgres" };
        yield* normalizeSlimServicesLayout(postgresArtifact, destination);
        expect(yield* fs.exists(`${destination}/share/supabase-cli/init-scripts`)).toBe(false);
        expect(yield* fs.exists(initScripts)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("removes an extracted duplicate Postgres init-script tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({
          prefix: "slim-services-postgres-duplicate-",
        });
        const target = `${destination}/share/supabase-cli/migrations/init-scripts`;
        const alias = `${destination}/share/supabase-cli/init-scripts`;
        yield* fs.makeDirectory(target, { recursive: true });
        yield* fs.makeDirectory(alias, { recursive: true });
        yield* fs.writeFileString(`${target}/migration.sql`, "target");
        yield* fs.writeFileString(`${alias}/migration.sql`, "duplicate");
        yield* normalizeSlimServicesLayout({ ...artifact, service: "postgres" }, destination);
        expect(yield* fs.exists(alias)).toBe(false);
        expect(yield* fs.readFileString(`${target}/migration.sql`)).toBe("target");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("removes a contained Postgres init-scripts symlink without touching its target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({
          prefix: "slim-services-postgres-symlink-",
        });
        const target = `${destination}/share/supabase-cli/migrations/init-scripts`;
        const alias = `${destination}/share/supabase-cli/init-scripts`;
        yield* fs.makeDirectory(target, { recursive: true });
        yield* fs.writeFileString(`${target}/migration.sql`, "target");
        yield* fs.symlink("migrations/init-scripts", alias);
        yield* normalizeSlimServicesLayout({ ...artifact, service: "postgres" }, destination);
        expect(yield* fs.exists(alias)).toBe(false);
        expect(yield* fs.readFileString(`${target}/migration.sql`)).toBe("target");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("rejects a Postgres init-scripts symlink that escapes its artifact root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({
          prefix: "slim-services-postgres-symlink-escape-",
        });
        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "slim-services-postgres-symlink-outside-",
        });
        const target = `${destination}/share/supabase-cli/migrations/init-scripts`;
        const alias = `${destination}/share/supabase-cli/init-scripts`;
        yield* fs.makeDirectory(target, { recursive: true });
        yield* fs.makeDirectory(outside, { recursive: true });
        yield* fs.symlink(outside, alias);
        const result = yield* normalizeSlimServicesLayout(
          { ...artifact, service: "postgres" },
          destination,
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(errorOf(result)).toBeInstanceOf(StackPreparationError);
        expect(yield* fs.exists(alias)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("verifies checksums and extracts a manifest-matched archive using injected fetch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const crypto = yield* Crypto.Crypto;
        const expected = digestHex(yield* crypto.digest("SHA-256", archive));
        const checksums = expected + "  demo-v1.0.0-linux-amd64.tar.zst\n";
        const fetcher: FetchLike = (input) => {
          const url = requestUrl(input);
          if (url.endsWith("SHA256SUMS")) return Promise.resolve(new Response(checksums));
          if (url.endsWith("manifest.json"))
            return Promise.resolve(
              new Response(
                JSON.stringify({ service: "demo", version: "v1.0.0", target: "linux-amd64" }),
              ),
            );
          return Promise.resolve(new Response(archive));
        };
        expect(yield* slimServicesChecksum(artifact, fetcher)).toBe(expected);
        const source = makeSlimServicesSource(() => artifact, fetcher);
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-source-" });
        yield* source.materialize({ ...request, sha256: expected }, destination);
        expect(yield* fs.readFileString(`${destination}/bin/demo`)).toBe("demo");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("rejects archive members that escape the artifact root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("../outside", "unsafe"));
        const crypto = yield* Crypto.Crypto;
        const expected = digestHex(yield* crypto.digest("SHA-256", archive));
        const fetcher: FetchLike = (input) => {
          const url = requestUrl(input);
          if (url.endsWith("SHA256SUMS"))
            return Promise.resolve(new Response(expected + "  demo-v1.0.0-linux-amd64.tar.zst\n"));
          if (url.endsWith("manifest.json"))
            return Promise.resolve(
              new Response(
                JSON.stringify({ service: "demo", version: "v1.0.0", target: "linux-amd64" }),
              ),
            );
          return Promise.resolve(new Response(archive));
        };
        const source = makeSlimServicesSource(() => artifact, fetcher);
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-unsafe-" });
        const failed = yield* source
          .materialize({ ...request, sha256: expected }, destination)
          .pipe(Effect.exit);
        expect(errorOf(failed)).toBeDefined();
        expect(yield* fs.exists(`${destination}/outside`)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("allows internal symlinks while rejecting malformed archives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(
          tarEntries([
            { name: "bin/demo", content: "demo" },
            { name: "bin/current", link: "demo" },
          ]),
        );
        const crypto = yield* Crypto.Crypto;
        const expected = digestHex(yield* crypto.digest("SHA-256", archive));
        const fetcher: FetchLike = (input) => {
          const url = requestUrl(input);
          if (url.endsWith("SHA256SUMS"))
            return Promise.resolve(new Response(expected + "  demo-v1.0.0-linux-amd64.tar.zst\n"));
          if (url.endsWith("manifest.json"))
            return Promise.resolve(
              new Response(
                JSON.stringify({ service: "demo", version: "v1.0.0", target: "linux-amd64" }),
              ),
            );
          return Promise.resolve(new Response(archive));
        };
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-links-" });
        yield* makeSlimServicesSource(() => artifact, fetcher).materialize(
          { ...request, sha256: expected },
          destination,
        );
        expect(yield* fs.readFileString(`${destination}/bin/current`)).toBe("demo");

        const malformed = yield* compress(new Uint8Array([1, 2, 3]));
        const malformedDigest = digestHex(yield* crypto.digest("SHA-256", malformed));
        const malformedFetcher: FetchLike = (input) => {
          const url = requestUrl(input);
          if (url.endsWith("SHA256SUMS"))
            return Promise.resolve(
              new Response(malformedDigest + "  demo-v1.0.0-linux-amd64.tar.zst\n"),
            );
          if (url.endsWith("manifest.json"))
            return Promise.resolve(
              new Response(
                JSON.stringify({ service: "demo", version: "v1.0.0", target: "linux-amd64" }),
              ),
            );
          return Promise.resolve(new Response(malformed));
        };
        const failed = yield* makeSlimServicesSource(() => artifact, malformedFetcher)
          .materialize({ ...request, sha256: malformedDigest }, destination)
          .pipe(Effect.exit);
        expect(errorOf(failed)).toBeDefined();
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("rejects links whose targets escape the artifact root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(
          tarEntries([
            { name: "bin/demo", content: "demo" },
            { name: "bin/escape", link: "../../outside" },
          ]),
        );
        const crypto = yield* Crypto.Crypto;
        const expected = digestHex(yield* crypto.digest("SHA-256", archive));
        const fetcher: FetchLike = (input) => {
          const url = requestUrl(input);
          if (url.endsWith("SHA256SUMS"))
            return Promise.resolve(new Response(`${expected}  demo-v1.0.0-linux-amd64.tar.zst\n`));
          if (url.endsWith("manifest.json"))
            return Promise.resolve(
              new Response(
                JSON.stringify({ service: "demo", version: "v1.0.0", target: "linux-amd64" }),
              ),
            );
          return Promise.resolve(new Response(archive));
        };
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({
          prefix: "slim-services-link-escape-",
        });
        const failed = yield* makeSlimServicesSource(() => artifact, fetcher)
          .materialize({ ...request, sha256: expected }, destination)
          .pipe(Effect.exit);
        expect(errorOf(failed)).toBeDefined();
        expect(yield* fs.exists(`${destination}/outside`)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("interrupts an in-flight download without publishing a staging artifact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let signal: AbortSignal | undefined;
        const fetcher: FetchLike = (input, init) => {
          const url = requestUrl(input);
          if (url.endsWith("manifest.json"))
            return Promise.resolve(
              new Response(
                JSON.stringify({ service: "demo", version: "v1.0.0", target: "linux-amd64" }),
              ),
            );
          if (url.endsWith("SHA256SUMS"))
            return Promise.resolve(
              new Response("0".repeat(64) + "  demo-v1.0.0-linux-amd64.tar.zst\n"),
            );
          signal = init?.signal ?? undefined;
          // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- signal the test's injected fetch boundary
          void Effect.runPromise(Deferred.succeed(started, undefined));
          // oxlint-disable-next-line effecttsgo/new-promise -- fetch fixture intentionally remains pending until abort
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        };
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({
          prefix: "slim-services-interrupt-",
        });
        const fiber = yield* Effect.forkChild(
          makeSlimServicesSource(() => artifact, fetcher).materialize(request, destination),
          { startImmediately: true },
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(signal?.aborted).toBe(true);
        expect(yield* fs.readDirectory(destination)).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("interrupts owned decompression without publishing a staging artifact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const crypto = yield* Crypto.Crypto;
        const expected = digestHex(yield* crypto.digest("SHA-256", archive));
        const started = yield* Deferred.make<void>();
        let destroyed = false;
        const decompressor: ZstdDecompressor = {
          decompress: () =>
            Effect.callback((_resume) => {
              // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- test boundary signal
              void Effect.runPromise(Deferred.succeed(started, undefined));
              return Effect.sync(() => {
                destroyed = true;
              });
            }),
        };
        const fetcher: FetchLike = (input) => {
          const url = requestUrl(input);
          if (url.endsWith("SHA256SUMS"))
            return Promise.resolve(new Response(`${expected}  demo-v1.0.0-linux-amd64.tar.zst\n`));
          if (url.endsWith("manifest.json"))
            return Promise.resolve(
              new Response(
                JSON.stringify({ service: "demo", version: "v1.0.0", target: "linux-amd64" }),
              ),
            );
          return Promise.resolve(new Response(archive));
        };
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-zstd-" });
        const fiber = yield* Effect.forkChild(
          makeSlimServicesSource(
            () => artifact,
            fetcher,
            systemTarBoundary,
            decompressor,
          ).materialize({ ...request, sha256: expected }, destination),
          { startImmediately: true },
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(destroyed).toBe(true);
        expect(yield* fs.readDirectory(destination)).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("accepts PAX long paths through the system tar boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const longName = `bin/${"long-function-name-".repeat(8)}.js`;
        const archive = yield* compress(paxTar(longName));
        const crypto = yield* Crypto.Crypto;
        const expected = digestHex(yield* crypto.digest("SHA-256", archive));
        const fetcher: FetchLike = (input) => {
          const url = requestUrl(input);
          if (url.endsWith("SHA256SUMS"))
            return Promise.resolve(new Response(expected + "  demo-v1.0.0-linux-amd64.tar.zst\n"));
          if (url.endsWith("manifest.json"))
            return Promise.resolve(
              new Response(
                JSON.stringify({ service: "demo", version: "v1.0.0", target: "linux-amd64" }),
              ),
            );
          return Promise.resolve(new Response(archive));
        };
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-pax-" });
        yield* makeSlimServicesSource(() => artifact, fetcher).materialize(
          { ...request, sha256: expected },
          destination,
        );
        expect(yield* fs.exists(`${destination}/${longName}`)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("publishes the extracted slim artifact through the verified store", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const crypto = yield* Crypto.Crypto;
        const expected = digestHex(yield* crypto.digest("SHA-256", archive));
        const checksums = `${expected}  demo-v1.0.0-linux-amd64.tar.zst\n`;
        const fetcher: FetchLike = (input) => {
          const url = requestUrl(input);
          if (url.endsWith("SHA256SUMS")) return Promise.resolve(new Response(checksums));
          if (url.endsWith("manifest.json"))
            return Promise.resolve(
              new Response(
                JSON.stringify({ service: "demo", version: "v1.0.0", target: "linux-amd64" }),
              ),
            );
          return Promise.resolve(new Response(archive));
        };
        const source = makeSlimServicesSource(() => artifact, fetcher);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-store-" });
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const prepared = yield* store.prepare({ ...request, sha256: expected });
        expect(prepared.outcome).toBe("downloaded");
        expect(yield* fs.readFileString(`${prepared.path}/bin/demo`)).toBe("demo");
        expect(yield* fs.exists(`${prepared.path}/.artifact.json`)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
