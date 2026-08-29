import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Crypto, Effect, Exit, FileSystem, Option } from "effect";
import { zstdCompress } from "node:zlib";
import { makeArtifactStore, type ArtifactRequest } from "./ArtifactStore.ts";
import { digestHex } from "./Integrity.ts";
import { makeSlimServicesSource, slimServicesChecksum } from "./SlimServicesSource.ts";
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

const tar = (name: string, content: string): Uint8Array => {
  const bytes = new Uint8Array(1024);
  const header = bytes.subarray(0, 512);
  header.set(new TextEncoder().encode(name), 0);
  const size = content.length.toString(8).padStart(11, "0");
  header.set(new TextEncoder().encode(`${size}\0`), 124);
  header[156] = 48;
  header.set(new TextEncoder().encode("ustar\0"), 257);
  bytes.set(new TextEncoder().encode(content), 512);
  return bytes;
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
  it.live("verifies checksums and extracts a manifest-matched archive using injected fetch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("bin/demo", "demo"));
        const checksums = "0".repeat(64) + "  demo-v1.0.0-linux-amd64.tar.zst\n";
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
        expect(yield* slimServicesChecksum(artifact, fetcher)).toBe("0".repeat(64));
        const source = makeSlimServicesSource(() => artifact, fetcher);
        const fs = yield* FileSystem.FileSystem;
        const destination = yield* fs.makeTempDirectoryScoped({ prefix: "slim-services-source-" });
        yield* source.materialize(request, destination);
        expect(yield* fs.readFileString(`${destination}/bin/demo`)).toBe("demo");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("rejects archive members that escape the artifact root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* compress(tar("../outside", "unsafe"));
        const fetcher: FetchLike = (input) => {
          const url = requestUrl(input);
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
        const failed = yield* source.materialize(request, destination).pipe(Effect.exit);
        expect(errorOf(failed)).toBeDefined();
        expect(yield* fs.exists(`${destination}/outside`)).toBe(false);
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
