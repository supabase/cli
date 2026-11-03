import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { Console, Crypto, Effect, FileSystem, Layer } from "effect";
import {
  makeArtifactStore,
  type ArtifactRequest,
  type ArtifactSource,
} from "../src/preparation/ArtifactStore.ts";
import { ArtifactIntegrityError, PreparationError } from "../src/preparation/Errors.ts";
import { verifySha256 } from "../src/preparation/Integrity.ts";

const mapMaterializeError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof PreparationError || cause instanceof ArtifactIntegrityError
        ? cause
        : new PreparationError({
            message: `materialization failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
    ),
  );

/**
 * Cross-process fixture for `artifacts.integration.test.ts`: real preparer/pin races need real
 * separate processes, not fibers in one process. Modes:
 * - `prepare`: ahead-of-time `store.prepare`, prints `prepared:<outcome>:<path>:<sha256>`, exits.
 * - `use`: scoped `store.use`, prints `used:<outcome>:<path>:<lockPath>`, then blocks forever so
 *   the parent controls the pin's release by killing this process.
 * - `stall`: `store.prepare` whose materialize prints `started` once extraction has begun, then
 *   blocks forever, so the parent can synchronize a SIGKILL precisely mid-extraction without
 *   polling.
 */
const [mode, cacheRoot, key] = process.argv.slice(2);
if (mode === undefined || cacheRoot === undefined || key === undefined)
  throw new Error("Usage: artifact-store-fixture <prepare|use|stall> <cacheRoot> <key>");

const archive = new TextEncoder().encode("archive");
const archiveSha256 = "0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3";

const request: ArtifactRequest = {
  key,
  requiredRuntimePaths: ["bin/postgres", "etc/postgres.conf"],
  executablePath: "bin/postgres",
};

const fastSource: ArtifactSource = {
  checksum: () => Effect.succeed(archiveSha256),
  materialize: (_request, destination, expectedSha256) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
      yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
      yield* fs.writeFileString(`${destination}/bin/postgres`, "native postgres", { mode: 0o755 });
      yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config", { mode: 0o644 });
      const crypto = yield* Crypto.Crypto;
      yield* verifySha256(archive, expectedSha256).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      );
    }).pipe(mapMaterializeError),
};

const stallingSource: ArtifactSource = {
  checksum: () => Effect.succeed(archiveSha256),
  materialize: (_request, destination) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
      yield* Console.log("started");
      return yield* Effect.never;
    }).pipe(mapMaterializeError),
};

const program = Effect.scoped(
  Effect.gen(function* () {
    const store = yield* makeArtifactStore({
      cacheRoot,
      source: mode === "stall" ? stallingSource : fastSource,
    });
    if (mode === "prepare" || mode === "stall") {
      const prepared = yield* store.prepare(request);
      yield* Console.log(`prepared:${prepared.outcome}:${prepared.path}:${prepared.sha256}`);
      return;
    }
    if (mode === "use") {
      const prepared = yield* store.use(request);
      yield* Console.log(`used:${prepared.outcome}:${prepared.path}:${prepared.lockPath}`);
      return yield* Effect.never;
    }
    throw new Error(`Unknown fixture mode: ${mode}`);
  }),
).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)));

await Effect.runPromise(program);
