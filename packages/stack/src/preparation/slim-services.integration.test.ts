import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schedule,
} from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the redirect test owns a local native listener.
import { createServer, type Server } from "node:http";
import { zstdCompress } from "node:zlib";
import { FetchHttpClient } from "effect/http";
import { catalogPins, prepareNativeArtifact, resolveArtifact } from "../Artifacts.ts";
import { makeArtifactStore, type ArtifactRequest, type ArtifactSource } from "./ArtifactStore.ts";
import { digestHex } from "./Integrity.ts";
import {
  makeSlimServicesSource,
  type SlimServicesArtifact,
  type ZstdDecompressor,
} from "./SlimServicesSource.ts";
import { PreparationError } from "./Errors.ts";

const waitForAbort = (signal?: AbortSignal | null): Promise<never> =>
  Effect.runPromise(Effect.never, { signal: signal ?? undefined });

const waitForRelease = (released: Deferred.Deferred<void>): Promise<void> =>
  Effect.runPromise(Deferred.await(released));

const manifestBytes = (version: string, service = "demo"): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ service, version, target: "linux-amd64" }));

const demoManifest = manifestBytes("v1.0.0-r0");

/** Passes every manifest check except its pin. */
const commandManifest = new TextEncoder().encode(
  JSON.stringify({
    service: "demo",
    version: "v1.0.0-r0",
    target: "linux-amd64",
    cmd: ["bin/evil"],
  }),
);

const artifact: SlimServicesArtifact = {
  provider: "supabase/slim-services",
  service: "demo",
  version: "v1.0.0-r0",
  releaseTag: "demo-v1.0.0-r0",
  target: "linux-amd64",
  archive: "tar.zst",
  assetName: "demo-v1.0.0-r0-linux-amd64",
  sha256: "0".repeat(64),
  manifestSha256: "0".repeat(64),
  mirrors: [
    {
      downloadUrl: "https://example.test/demo.tar.zst",
      manifestUrl: "https://example.test/demo.manifest.json",
    },
  ],
  requiredRuntimePaths: ["bin/demo"],
  executablePath: "bin/demo",
};

const releaseMirror = {
  downloadUrl: "https://release.test/demo-v1.0.0-r0-linux-amd64.tar.zst",
  manifestUrl: "https://release.test/demo-v1.0.0-r0-linux-amd64.manifest.json",
};
const bucketMirror = {
  downloadUrl: "https://bucket.test/demo-v1.0.0-r0-linux-amd64.tar.zst",
  manifestUrl: "https://bucket.test/demo-v1.0.0-r0-linux-amd64.manifest.json",
};

const sha256Of = Effect.fn(function* (bytes: Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  return digestHex(yield* crypto.digest("SHA-256", bytes));
});

/** Pins `base` to the digests of the given archive and manifest bytes. */
const pinned = Effect.fn(function* (
  archive: Uint8Array,
  manifest: Uint8Array = demoManifest,
  base: SlimServicesArtifact = artifact,
) {
  return {
    ...base,
    sha256: yield* sha256Of(archive),
    manifestSha256: yield* sha256Of(manifest),
  } satisfies SlimServicesArtifact;
});

const request: ArtifactRequest = {
  key: "demo/v1",
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

/** Keeps retry coverage off the production backoff, whose jittered delays would idle the suite. */
const immediate = Schedule.spaced(Duration.zero);

const withFetch = <A, E, R>(fetcher: FetchLike, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetcher),
  );

/** Serves each host's manifest and archive, answers 403 elsewhere, and records every URL. */
const serving =
  (
    hosts: Readonly<
      Record<string, { readonly archive: Uint8Array; readonly manifest: Uint8Array }>
    >,
    requested: Array<string> = [],
  ): FetchLike =>
  (input) => {
    const url = requestUrl(input);
    requested.push(url);
    const host = hosts[new URL(url).host];
    if (host === undefined) return Promise.resolve(new Response("", { status: 403 }));
    return Promise.resolve(
      new Response(url.endsWith(".manifest.json") ? host.manifest : host.archive),
    );
  };

const fixtureSource = (content: string): ArtifactSource => ({
  checksum: () => Effect.succeed("0".repeat(64)),
  materialize: (entry, destination) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const file of entry.requiredRuntimePaths) {
        yield* fs.makeDirectory(`${destination}/${file.slice(0, file.lastIndexOf("/"))}`, {
          recursive: true,
        });
        yield* fs.writeFileString(`${destination}/${file}`, content);
        yield* fs.chmod(`${destination}/${file}`, 0o755);
      }
    }).pipe(
      Effect.mapError(
        (cause) => new PreparationError({ message: "Unable to write cache fixture", cause }),
      ),
    ),
});

describe("slim-services artifact source", () => {
  it.live("follows release redirects through the supplied Node HTTP client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const server = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              // oxlint-disable-next-line effecttsgo/new-promise -- node server listen exposes a callback lifecycle.
              new Promise<Server>((resolve, reject) => {
                const value = createServer((request, response) => {
                  const url = request.url ?? "";
                  if (url.startsWith("/redirect/")) {
                    response.statusCode = 302;
                    response.setHeader("location", url.slice("/redirect".length));
                    response.end();
                    return;
                  }
                  response.end(url.endsWith(".manifest.json") ? demoManifest : archive);
                });
                value.once("error", reject);
                value.listen(0, "127.0.0.1", () => resolve(value));
              }),
            catch: (cause) =>
              new PreparationError({ message: "Unable to start redirect server", cause }),
          }),
          (value) =>
            Effect.callback<void>((resume) => {
              value.close(() => resume(Effect.asVoid(Effect.succeed(true))));
              return Effect.asVoid(Effect.succeed(true));
            }),
        );
        const address = server.address();
        if (address === null || typeof address === "string")
          return yield* Effect.die("redirect server did not expose a port");
        const origin = `http://127.0.0.1:${address.port}/redirect`;
        const redirected = yield* pinned(archive, demoManifest, {
          ...artifact,
          mirrors: [
            {
              downloadUrl: `${origin}/demo.tar.zst`,
              manifestUrl: `${origin}/demo.manifest.json`,
            },
          ],
        });
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({
          prefix: "slim-services-redirect-",
        });
        yield* makeSlimServicesSource(() => redirected).materialize(
          request,
          destination,
          redirected.sha256,
        );
        expect(yield* fs.readFileString(`${destination}/bin/demo`)).toBe("demo");
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    ),
  );

  it.live("prepares a pinned archive and manifest without fetching any checksum", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const demo = yield* pinned(archive);
        const requested: string[] = [];
        const fetcher = serving({ "example.test": { archive, manifest: demoManifest } }, requested);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-store-" });
        const store = yield* makeArtifactStore({
          cacheRoot: root,
          source: makeSlimServicesSource(() => demo),
        });

        const prepared = yield* withFetch(fetcher, store.prepare(request));
        expect(prepared.outcome).toBe("downloaded");
        expect(prepared.sha256).toBe(demo.sha256);
        expect(yield* fs.readFileString(`${prepared.path}/bin/demo`)).toBe("demo");
        expect(requested).toEqual([demo.mirrors[0].manifestUrl, demo.mirrors[0].downloadUrl]);

        const cached = yield* withFetch(fetcher, store.prepare(request));
        expect(cached.outcome).toBe("cached");
        expect(requested).toHaveLength(2);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("retries a gateway error on the manifest and a truncated archive transfer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const demo = yield* pinned(archive);
        const attempts = new Map<string, number>();
        const count = (url: string): number => {
          const next = (attempts.get(url) ?? 0) + 1;
          attempts.set(url, next);
          return next;
        };
        const truncated = () =>
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(archive.slice(0, 4));
              controller.error("connection reset");
            },
          });
        const flaky: FetchLike = (input) => {
          const url = requestUrl(input);
          if (url.endsWith("manifest.json"))
            return Promise.resolve(
              count(url) === 1 ? new Response("", { status: 504 }) : new Response(demoManifest),
            );
          return Promise.resolve(
            count(url) === 1 ? new Response(truncated()) : new Response(archive),
          );
        };
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-retry-" });
        const source = makeSlimServicesSource(() => demo, { backoff: immediate });
        yield* withFetch(flaky, source.materialize(request, destination, demo.sha256));
        expect(yield* fs.readFileString(`${destination}/bin/demo`)).toBe("demo");
        expect(attempts.get(demo.mirrors[0].manifestUrl)).toBe(2);
        expect(attempts.get(demo.mirrors[0].downloadUrl)).toBe(2);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("spends five attempts on a persistent gateway error and one on a missing asset", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const source = makeSlimServicesSource(() => artifact, { backoff: immediate });

        let gateway = 0;
        const exhausted = yield* withFetch(
          () => {
            gateway += 1;
            return Promise.resolve(new Response("", { status: 504 }));
          },
          source
            .materialize(
              request,
              yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-gateway-" }),
              artifact.sha256,
            )
            .pipe(Effect.exit),
        );
        expect(errorOf(exhausted)).toBeInstanceOf(PreparationError);
        expect(gateway).toBe(5);

        let missing = 0;
        const failed = yield* withFetch(
          () => {
            missing += 1;
            return Promise.resolve(new Response("", { status: 404 }));
          },
          source
            .materialize(
              request,
              yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-missing-" }),
              artifact.sha256,
            )
            .pipe(Effect.exit),
        );
        expect(errorOf(failed)).toBeInstanceOf(PreparationError);
        expect(missing).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("prepares the artifact from the next mirror when the release host is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const mirrored = yield* pinned(archive, demoManifest, {
          ...artifact,
          mirrors: [releaseMirror, bucketMirror],
        });
        const requested: string[] = [];
        const fetcher = serving({ "bucket.test": { archive, manifest: demoManifest } }, requested);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-fallback-" });
        const store = yield* makeArtifactStore({
          cacheRoot: root,
          source: makeSlimServicesSource(() => mirrored, { backoff: immediate }),
        });
        const prepared = yield* withFetch(fetcher, store.prepare(request));
        expect(prepared.outcome).toBe("downloaded");
        expect(yield* fs.readFileString(`${prepared.path}/bin/demo`)).toBe("demo");
        expect(requested).toEqual([
          releaseMirror.manifestUrl,
          bucketMirror.manifestUrl,
          bucketMirror.downloadUrl,
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("falls through to the next mirror when the primary serves a tampered archive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const tampered = yield* compress(tar("bin/demo", "evil"));
        const mirrored = yield* pinned(archive, demoManifest, {
          ...artifact,
          mirrors: [releaseMirror, bucketMirror],
        });
        const requested: string[] = [];
        const fetcher = serving(
          {
            "release.test": { archive: tampered, manifest: demoManifest },
            "bucket.test": { archive, manifest: demoManifest },
          },
          requested,
        );
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-archive-" });
        yield* withFetch(
          fetcher,
          makeSlimServicesSource(() => mirrored).materialize(request, destination, mirrored.sha256),
        );
        expect(yield* fs.readFileString(`${destination}/bin/demo`)).toBe("demo");
        expect(requested).toEqual([
          releaseMirror.manifestUrl,
          releaseMirror.downloadUrl,
          bucketMirror.manifestUrl,
          bucketMirror.downloadUrl,
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("falls through to the next mirror when the primary serves a tampered manifest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const mirrored = yield* pinned(archive, demoManifest, {
          ...artifact,
          mirrors: [releaseMirror, bucketMirror],
        });
        const requested: string[] = [];
        const fetcher = serving(
          {
            "release.test": { archive, manifest: commandManifest },
            "bucket.test": { archive, manifest: demoManifest },
          },
          requested,
        );
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({
          prefix: "slim-services-manifest-",
        });
        yield* withFetch(
          fetcher,
          makeSlimServicesSource(() => mirrored).materialize(request, destination, mirrored.sha256),
        );
        expect(yield* fs.readFileString(`${destination}/bin/demo`)).toBe("demo");
        expect(requested).toEqual([
          releaseMirror.manifestUrl,
          bucketMirror.manifestUrl,
          bucketMirror.downloadUrl,
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("names every mirror and its mismatch when none serves the pinned bytes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const tampered = yield* compress(tar("bin/demo", "evil"));
        const tamperedManifest = manifestBytes("v1.0.0-r0", "evil");
        const mirrored = yield* pinned(archive, demoManifest, {
          ...artifact,
          mirrors: [releaseMirror, bucketMirror],
        });
        const fetcher = serving({
          "release.test": { archive: tampered, manifest: demoManifest },
          "bucket.test": { archive, manifest: tamperedManifest },
        });
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-reject-" });
        const failed = yield* withFetch(
          fetcher,
          makeSlimServicesSource(() => mirrored)
            .materialize(request, destination, mirrored.sha256)
            .pipe(Effect.exit),
        );
        expect(errorOf(failed)?.message).toBe(
          "Unable to download the slim-services archive: " +
            `${releaseMirror.downloadUrl} (Unable to download slim-services archive: ` +
            `expected ${mirrored.sha256}, got ${yield* sha256Of(tampered)}); ` +
            `${bucketMirror.downloadUrl} (Slim-services manifest does not match its pin: ` +
            `expected ${mirrored.manifestSha256}, got ${yield* sha256Of(tamperedManifest)})`,
        );
        expect(yield* fs.exists(`${destination}/bin/demo`)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("rejects a manifest that names the upstream version instead of the release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const upstreamManifest = manifestBytes("v1.0.0");
        const demo = yield* pinned(archive, upstreamManifest);
        const requested: string[] = [];
        const fetcher = serving(
          { "example.test": { archive, manifest: upstreamManifest } },
          requested,
        );
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-version-" });
        const failed = yield* withFetch(
          fetcher,
          makeSlimServicesSource(() => demo)
            .materialize(request, destination, demo.sha256)
            .pipe(Effect.exit),
        );
        expect(errorOf(failed)?.message).toBe(
          "Slim-services manifest does not match the catalog artifact",
        );
        expect(requested).toEqual([demo.mirrors[0].manifestUrl]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("rejects archive members that escape the artifact root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("../outside", "unsafe"));
        const demo = yield* pinned(archive);
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-unsafe-" });
        const failed = yield* withFetch(
          serving({ "example.test": { archive, manifest: demoManifest } }),
          makeSlimServicesSource(() => demo)
            .materialize(request, destination, demo.sha256)
            .pipe(Effect.exit),
        );
        expect(errorOf(failed)).toBeInstanceOf(PreparationError);
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
        const demo = yield* pinned(archive);
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-links-" });
        yield* withFetch(
          serving({ "example.test": { archive, manifest: demoManifest } }),
          makeSlimServicesSource(() => demo).materialize(request, destination, demo.sha256),
        );
        expect(yield* fs.readFileString(`${destination}/bin/current`)).toBe("demo");

        const malformed = yield* compress(new Uint8Array([1, 2, 3]));
        const malformedDemo = yield* pinned(malformed);
        const failed = yield* withFetch(
          serving({ "example.test": { archive: malformed, manifest: demoManifest } }),
          makeSlimServicesSource(() => malformedDemo)
            .materialize(request, destination, malformedDemo.sha256)
            .pipe(Effect.exit),
        );
        expect(errorOf(failed)).toBeInstanceOf(PreparationError);
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
        const demo = yield* pinned(archive);
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({
          prefix: "slim-services-link-escape-",
        });
        const failed = yield* withFetch(
          serving({ "example.test": { archive, manifest: demoManifest } }),
          makeSlimServicesSource(() => demo)
            .materialize(request, destination, demo.sha256)
            .pipe(Effect.exit),
        );
        expect(errorOf(failed)).toBeInstanceOf(PreparationError);
        expect(yield* fs.exists(`${destination}/outside`)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("interrupts an in-flight download without publishing a staging artifact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const demo = yield* pinned(new Uint8Array());
        const started = yield* Deferred.make<void>();
        let signal: AbortSignal | undefined;
        const fetcher: FetchLike = (input, init) => {
          if (requestUrl(input).endsWith("manifest.json"))
            return Promise.resolve(new Response(demoManifest));
          signal = init?.signal ?? undefined;
          Deferred.doneUnsafe(started, Effect.void);
          return waitForAbort(signal);
        };
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({
          prefix: "slim-services-interrupt-",
        });
        const fiber = yield* Effect.forkChild(
          withFetch(
            fetcher,
            makeSlimServicesSource(() => demo).materialize(request, destination, demo.sha256),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(signal?.aborted).toBe(true);
        expect(yield* fs.readDirectory(destination)).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("rejects an archive that misses its pin before publishing and retries cleanly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const demo = yield* pinned(archive);
        let current: SlimServicesArtifact = { ...demo, sha256: "0".repeat(64) };
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "slim-services-store-integrity-",
        });
        const store = yield* makeArtifactStore({
          cacheRoot: root,
          source: makeSlimServicesSource(() => current),
        });
        const fetcher = serving({ "example.test": { archive, manifest: demoManifest } });
        const failed = yield* withFetch(fetcher, store.prepare(request).pipe(Effect.exit));
        expect(Exit.isFailure(failed)).toBe(true);
        expect(yield* fs.exists(`${root}/demo/v1`)).toBe(false);
        current = demo;
        const prepared = yield* withFetch(fetcher, store.prepare(request));
        expect(yield* fs.readFileString(`${prepared.path}/bin/demo`)).toBe("demo");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("cancels a streamed response after transfer starts and removes its staging file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const demo = yield* pinned(new Uint8Array());
        const started = yield* Deferred.make<void>();
        let signal: AbortSignal | undefined;
        let canceled = false;
        const fetcher: FetchLike = (input, init) => {
          if (requestUrl(input).endsWith("manifest.json"))
            return Promise.resolve(new Response(demoManifest));
          signal = init?.signal ?? undefined;
          let pulls = 0;
          const released = Deferred.makeUnsafe<void>();
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) {
                controller.enqueue(new Uint8Array([1]));
                return;
              }
              Deferred.doneUnsafe(started, Effect.void);
              return waitForRelease(released);
            },
            cancel() {
              canceled = true;
              pulls = 99;
              Deferred.doneUnsafe(released, Effect.void);
            },
          });
          return Promise.resolve(new Response(body));
        };
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-stream-" });
        const fiber = yield* Effect.forkChild(
          withFetch(
            fetcher,
            makeSlimServicesSource(() => demo).materialize(request, destination, demo.sha256),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(signal?.aborted).toBe(true);
        expect(canceled).toBe(true);
        expect(yield* fs.readDirectory(destination)).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("interrupts owned decompression without publishing a staging artifact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const demo = yield* pinned(archive);
        const started = yield* Deferred.make<void>();
        let destroyed = false;
        const decompressor: ZstdDecompressor = {
          decompress: () =>
            Effect.callback((_resume) => {
              Deferred.doneUnsafe(started, Effect.void);
              return Effect.sync(() => {
                destroyed = true;
              });
            }),
        };
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-zstd-" });
        const fiber = yield* Effect.forkChild(
          withFetch(
            serving({ "example.test": { archive, manifest: demoManifest } }),
            makeSlimServicesSource(() => demo, { decompressor }).materialize(
              request,
              destination,
              demo.sha256,
            ),
          ),
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
        const demo = yield* pinned(archive);
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-pax-" });
        yield* withFetch(
          serving({ "example.test": { archive, manifest: demoManifest } }),
          makeSlimServicesSource(() => demo).materialize(request, destination, demo.sha256),
        );
        expect(yield* fs.exists(`${destination}/${longName}`)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});

describe("native artifact catalog", () => {
  const linux = { os: "linux", arch: "x64" };
  const s3 = "supabase-cli-artifacts.s3.us-east-1.amazonaws.com";

  it.live(
    "requests release-versioned assets from GitHub, then S3, and rejects unpinned bytes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { version, releaseVersion } = yield* resolveArtifact({ service: "rest" });
          expect(releaseVersion).toMatch(/-r(0|[1-9][0-9]*)$/u);
          expect(releaseVersion.startsWith(`${version}-r`)).toBe(true);
          const asset = `postgrest-${releaseVersion}-linux-amd64`;
          const archive = yield* compress(tar("bin/postgrest", "postgrest"));
          const manifest = manifestBytes(releaseVersion, "postgrest");
          const requested: string[] = [];
          const fetcher = serving(
            { "github.com": { archive, manifest }, [s3]: { archive, manifest } },
            requested,
          );
          const fs = yield* FileSystem.FileSystem;
          const cacheRoot = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-catalog-" });
          const failed = yield* withFetch(
            fetcher,
            prepareNativeArtifact({ service: "rest" }, cacheRoot, linux).pipe(Effect.exit),
          );
          const github = `https://github.com/supabase/slim-services/releases/download/postgrest-${releaseVersion}`;
          const bucket = `https://${s3}/postgrest/${releaseVersion}`;
          expect(requested).toEqual([
            `${github}/${asset}.manifest.json`,
            `${bucket}/${asset}.manifest.json`,
          ]);
          const message = errorOf(failed)?.message ?? "";
          expect(message).toContain(
            `${github}/${asset}.tar.zst (Slim-services manifest does not match its pin`,
          );
          expect(message).toContain(
            `${bucket}/${asset}.tar.zst (Slim-services manifest does not match its pin`,
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.live("keys the native cache by release version and ignores a legacy upstream entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const resolved = yield* resolveArtifact({ service: "rest" });
        const fs = yield* FileSystem.FileSystem;
        const cacheRoot = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-cache-" });
        const requested: string[] = [];
        const seed = (version: string, content: string) =>
          makeArtifactStore({ cacheRoot, source: fixtureSource(content) }).pipe(
            Effect.flatMap((store) =>
              withFetch(
                serving({}, requested),
                store.prepare({
                  key: `slim-services/postgrest/${version}/linux-amd64`,
                  requiredRuntimePaths: resolved.requiredRuntimePaths,
                  executablePath: resolved.executablePath,
                }),
              ),
            ),
          );
        const prepare = withFetch(
          serving({}, requested),
          prepareNativeArtifact({ service: "rest" }, cacheRoot, linux),
        );

        yield* seed(resolved.version, "legacy");
        expect(Exit.isFailure(yield* prepare.pipe(Effect.exit))).toBe(true);
        expect(requested).not.toEqual([]);

        const seeded = yield* seed(resolved.releaseVersion, "pinned");
        requested.length = 0;
        const prepared = yield* prepare;
        expect(prepared.root).toBe(seeded.path);
        expect(yield* fs.readFileString(prepared.executable)).toBe("pinned");
        expect(requested).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it("catalog has no placeholder pins", () => {
    const digests = catalogPins().flatMap(({ pin }) => [
      pin.image.slice(pin.image.lastIndexOf(":") + 1),
      ...Object.values(pin.natives).flatMap((native) => [native.archive, native.manifest]),
    ]);
    expect(digests).not.toContain("0".repeat(64));
  });
});
