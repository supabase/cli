import { createHash } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem.copyFile does not expose forced reflink flags.
import { constants } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem.copyFile does not expose forced reflink flags.
import { copyFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { Data, Effect, FileSystem, Layer, Path, PlatformError, Schema } from "effect";
import { postgresVersion } from "../src/Artifacts.ts";
import { makeDatabaseSnapshots as makeTar } from "../src/services/DatabaseSnapshot.ts";
import { makeDatabaseSnapshots as makeDirectory } from "../src/services/DatabaseSnapshotDirectory.ts";

class BenchmarkError extends Data.TaggedError("SnapshotBenchmarkError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
const arg = (name: string, fallback: string) =>
  process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const repetitions = Number(arg("reps", "5"));
const warmups = Number(arg("warmups", "1"));
const sizes = arg("sizes", "50,256").split(",").map(Number);
const variants = ["tar", "copy", "clone"] as const;
type Variant = (typeof variants)[number];
interface Measurement {
  readonly variant: Variant;
  readonly sizeMiB: number;
  readonly repetition: number;
  readonly warmup: boolean;
  readonly exportMs: number;
  readonly restoreMs: number;
  readonly verifiedFiles: number;
  readonly isolation: boolean;
}
const assert = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new BenchmarkError({ message }));
const digest = (bytes: Uint8Array) =>
  Effect.try({
    try: () => createHash("sha256").update(bytes).digest("hex"),
    catch: (cause) => new BenchmarkError({ message: "Could not hash file", cause }),
  });
const makeSnapshots = (variant: Variant, instanceRoot: string) => {
  const options = {
    instanceRoot,
    runtime: "native" as const,
    version: "17",
    stackId: "snapshot-platform",
    instanceId: "fixture",
  };
  return variant === "tar"
    ? makeTar(options)
    : makeDirectory({ ...options, directoryCopyMode: variant });
};
const manifest = (
  root: string,
): Effect.Effect<
  Record<string, string>,
  BenchmarkError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const found: Record<string, string> = {};
    const walk = (
      directory: string,
      prefix: string,
    ): Effect.Effect<void, BenchmarkError | PlatformError.PlatformError> =>
      Effect.gen(function* () {
        for (const entry of (yield* fs.readDirectory(directory)).sort()) {
          const target = path.join(directory, entry);
          const relative = prefix ? `${prefix}/${entry}` : entry;
          const info = yield* fs.stat(target);
          if (info.type === "Directory") yield* walk(target, relative);
          else {
            yield* assert(info.type === "File", `Unexpected entry: ${relative}`);
            found[relative] = yield* digest(yield* fs.readFile(target));
          }
        }
      });
    yield* walk(root, "");
    return found;
  });
const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* assert(
      Number.isInteger(repetitions) &&
        repetitions > 0 &&
        Number.isInteger(warmups) &&
        warmups >= 0 &&
        sizes.every((size) => Number.isInteger(size) && size > 0),
      "Invalid benchmark arguments",
    );
    const parent = arg("root", path.join(tmpdir(), "snapshot-platform"));
    yield* fs.makeDirectory(parent, { recursive: true });
    const root = yield* fs.makeTempDirectoryScoped({ directory: parent, prefix: "run-" });
    const output = arg("out", path.join(parent, "results.json"));
    yield* fs.makeDirectory(path.dirname(output), { recursive: true });
    const probeSource = path.join(root, "probe-source");
    const probeTarget = path.join(root, "probe-target");
    yield* fs.writeFile(probeSource, new Uint8Array(1024 * 1024).fill(42));
    const cloneProbe = yield* Effect.tryPromise({
      try: () => copyFile(probeSource, probeTarget, constants.COPYFILE_FICLONE_FORCE),
      catch: (cause) => new BenchmarkError({ message: "Forced clone probe failed", cause }),
    }).pipe(
      Effect.map(() => ({ supported: true, error: "" })),
      Effect.catch((error) => Effect.succeed({ supported: false, error: String(error.cause) })),
    );
    if (cloneProbe.supported) {
      yield* fs.writeFileString(probeSource, "source mutation");
      yield* assert(
        (yield* fs.readFile(probeTarget)).length === 1024 * 1024,
        "Forced clone aliases source writes",
      );
    }
    const measurements: Measurement[] = [];
    const report = () => ({
      fixture: "synthetic physical-cluster files; full snapshot API; no PostgreSQL process",
      machine: {
        platform: platform(),
        arch: arch(),
        kernel: release(),
        cpu: cpus()[0]?.model,
        bun: process.versions.bun,
        node: process.versions.node,
        filesystemPath: parent,
        cloneProbe,
      },
      repetitions,
      warmups,
      sizesMiB: sizes,
      measurements,
    });
    for (const sizeMiB of sizes) {
      const source = path.join(root, `source-${sizeMiB}`);
      const data = path.join(source, "data");
      yield* fs.makeDirectory(data, { recursive: true });
      yield* fs.writeFileString(
        path.join(source, ".supabase-database-ready.json"),
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          version: postgresVersion("17"),
          runtime: "native",
          profile: "supabase",
        }),
      );
      yield* fs.writeFileString(path.join(data, "PG_VERSION"), "17\n");
      yield* fs.makeDirectory(path.join(data, "base"));
      for (let index = 0; index < sizeMiB; index++) {
        yield* fs.writeFile(
          path.join(data, "base", `segment-${index}`),
          new Uint8Array(1024 * 1024).fill((index % 251) + 1),
        );
      }
      const expected = yield* manifest(data);
      const matches = (actual: Record<string, string>) =>
        Object.keys(actual).length === Object.keys(expected).length &&
        Object.entries(expected).every(([name, hash]) => actual[name] === hash);
      const sourceFirst = path.join(data, "base", "segment-0");
      for (let repetition = 0; repetition < repetitions + warmups; repetition++) {
        const rotated = [
          ...variants.slice(repetition % variants.length),
          ...variants.slice(0, repetition % variants.length),
        ];
        for (const variant of rotated) {
          yield* Effect.log(`${variant} ${sizeMiB}MiB repetition ${repetition}: export/restore`);
          const snapshot = path.join(root, `snapshot-${sizeMiB}-${variant}-${repetition}`);
          const target = path.join(root, `target-${sizeMiB}-${variant}-${repetition}`);
          const sourceStore = yield* makeSnapshots(variant, source);
          yield* fs.makeDirectory(path.join(target, "data"), { recursive: true });
          const targetStore = yield* makeSnapshots(variant, target);
          const exportStart = performance.now();
          yield* sourceStore.exportSnapshot({ destination: snapshot });
          const exportMs = performance.now() - exportStart;
          if (repetition === 0) {
            const sentinel = path.join(target, "data", "sentinel");
            yield* fs.writeFileString(sentinel, "valuable data");
            const failure = yield* targetStore
              .restoreSnapshot({ source: snapshot })
              .pipe(Effect.flip);
            yield* assert(failure.operation === "restore", "Unexpected nonempty-target failure");
            yield* assert(
              (yield* fs.readFileString(sentinel)) === "valuable data",
              "Restore modified a nonempty target",
            );
            yield* fs.remove(sentinel);
          }

          yield* fs.writeFileString(sourceFirst, "source mutation");
          const restoreStart = performance.now();
          yield* targetStore.restoreSnapshot({ source: snapshot });
          const restoreMs = performance.now() - restoreStart;
          yield* assert(
            matches(yield* manifest(path.join(target, "data"))),
            `Restored hashes differ: ${variant}/${sizeMiB}`,
          );
          yield* assert(
            (yield* fs.readFileString(sourceFirst)) === "source mutation",
            "Restore modified source",
          );
          const targetFirst = path.join(target, "data", "base", "segment-0");
          yield* fs.writeFileString(targetFirst, "target mutation");
          yield* assert(
            (yield* fs.readFileString(sourceFirst)) === "source mutation",
            "Target write modified source",
          );
          if (variant !== "tar") {
            yield* assert(
              matches(yield* manifest(path.join(snapshot, "data"))),
              "Snapshot changed after source/target mutation",
            );
          }
          yield* fs.writeFile(sourceFirst, new Uint8Array(1024 * 1024).fill(1));
          yield* assert(
            matches(yield* manifest(data)),
            "Source fixture changed between repetitions",
          );
          yield* fs.remove(snapshot, { recursive: true });
          yield* fs.remove(target, { recursive: true });
          const measurement = {
            variant,
            sizeMiB,
            repetition,
            warmup: repetition < warmups,
            exportMs,
            restoreMs,
            verifiedFiles: Object.keys(expected).length,
            isolation: true,
          };
          measurements.push(measurement);
          yield* Effect.log(measurement);
          yield* fs.writeFileString(
            output,
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(report()),
          );
        }
      }
      yield* fs.remove(source, { recursive: true });
    }
    yield* Effect.log({ output, measurements: measurements.length, cloneProbe });
  }),
);
await Effect.runPromise(
  program.pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
