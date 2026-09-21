import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import {
  Clock,
  Console,
  Crypto,
  Data,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { create, postgres } from "../src/effect.ts";

class BenchmarkError extends Data.TaggedError("BenchmarkError")<{
  readonly message: string;
}> {}

type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

const filesystem = process.env.BENCHMARK_FILESYSTEM === "xfs" ? "xfs" : "ext4";
const dataset = process.env.BENCHMARK_DATASET === "large" ? "large" : "small";
const reps = Number(process.env.BENCHMARK_REPS ?? "3");
const baseDirectory = process.env.BENCHMARK_ROOT ?? "/tmp";
const helperImage =
  "debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251";

const read = (stream: Stream.Stream<Uint8Array, unknown, never>) =>
  stream.pipe(
    Stream.decodeText,
    Stream.runFold(
      () => "",
      (all, chunk) => all + chunk,
    ),
  );

const spawnCommand = (executable: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(ChildProcess.make(executable, args, { stdin: "ignore" }));
      const [stdout, stderr, code] = yield* Effect.all(
        [read(child.stdout), read(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      return {
        code: Number(code),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      } satisfies CommandResult;
    }),
  );

const command = (args: ReadonlyArray<string>) => spawnCommand("docker", args);

const checked = (args: ReadonlyArray<string>) =>
  command(args).pipe(
    Effect.flatMap((result) =>
      result.code === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(
            new BenchmarkError({
              message: `docker ${args.join(" ")} exited ${result.code}: ${result.stderr}`,
            }),
          ),
    ),
  );

const hostChecked = (executable: string, args: ReadonlyArray<string>) =>
  spawnCommand(executable, args).pipe(
    Effect.flatMap((result) =>
      result.code === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(
            new BenchmarkError({
              message: `${executable} ${args.join(" ")} exited ${result.code}: ${result.stderr}`,
            }),
          ),
    ),
  );

const hash = (crypto: Crypto.Crypto, value: string) =>
  crypto
    .digest("SHA-256", new TextEncoder().encode(value))
    .pipe(
      Effect.map((bytes) =>
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
    );

const measure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const begin = yield* Clock.currentTimeMillis;
    const value = yield* effect;
    return { value, ms: (yield* Clock.currentTimeMillis) - begin };
  });

const populate =
  dataset === "small"
    ? "CREATE TABLE snapshot_rows(id integer PRIMARY KEY,payload text NOT NULL); INSERT INTO snapshot_rows SELECT i,md5(i::text) FROM generate_series(1,96) i;"
    : "CREATE TABLE snapshot_rows(id integer PRIMARY KEY,payload text NOT NULL); ALTER TABLE snapshot_rows ALTER COLUMN payload SET STORAGE EXTERNAL; INSERT INTO snapshot_rows SELECT i,(SELECT string_agg(md5('snapshot-large-'||i||':'||j),'' ORDER BY j) FROM generate_series(1,256) j) FROM generate_series(1,32768) i;";
const check =
  "SELECT count(*),sum(length(payload)),md5(string_agg(md5(payload),'' ORDER BY id)) FROM snapshot_rows";
const expectedSmall = /^96\|[0-9]+\|[0-9a-f]{32}$/u;
const expectedLarge = /^32768\|268435456\|[0-9a-f]{32}$/u;

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const root = yield* fs.makeTempDirectory({
      directory: baseDirectory,
      prefix: "managed-snapshot-",
    });
    const stateRoot = path.join(root, "state");
    const cacheRoot = path.join(root, "cache");
    yield* fs.makeDirectory(stateRoot, { recursive: true });
    yield* fs.makeDirectory(cacheRoot, { recursive: true });

    const daemonId = yield* checked(["info", "--format", "{{.ID}}"]).pipe(
      Effect.map((id) => id.trim()),
    );
    const canonicalStateRoot = yield* fs.realPath(stateRoot);
    const stateDigest = yield* hash(crypto, `${canonicalStateRoot}\0${daemonId}`);
    const volume = `supabase-db-${stateDigest.slice(0, 32)}`;
    const volumeDirectory =
      filesystem === "xfs"
        ? path.join(baseDirectory, `volume-${stateDigest.slice(0, 16)}`)
        : undefined;
    if (volumeDirectory !== undefined) {
      yield* fs.makeDirectory(volumeDirectory, { recursive: true });
      yield* checked([
        "volume",
        "create",
        "--driver",
        "local",
        "--opt",
        "type=none",
        "--opt",
        "o=bind",
        "--opt",
        `device=${volumeDirectory}`,
        "--label",
        "com.supabase.stack-managed=true",
        "--label",
        `com.supabase.stack-state-root=${stateDigest}`,
        volume,
      ]);
    }

    const stack = yield* create({
      projectRoot: root,
      stateRoot,
      cacheRoot,
      runtime: "docker",
    });
    const config = {
      version: "17",
      databasePassword: Redacted.make("benchmark-secret"),
      jwtSecret: Redacted.make("benchmark-jwt-secret-with-enough-characters"),
      jwtExpiry: 3600,
    };
    const statFilesystem = (target: string) =>
      process.platform === "darwin"
        ? hostChecked("stat", ["-f", "%HT", target])
        : hostChecked("stat", ["-f", "-c", "%T", target]);
    const filesystemTable =
      process.platform === "darwin"
        ? hostChecked("df", ["-P", root, stateRoot, cacheRoot])
        : hostChecked("df", ["-T", root, stateRoot, cacheRoot]);
    const database = () =>
      stack.services.create({ service: "database", config, endpoints: { sql: { port: "auto" } } });
    const sql = (url: string, query: string) =>
      Effect.gen(function* () {
        let stdout = "";
        let stderr = "";
        const result = yield* stack.tools.run<never, never>(postgres.psql({ major: 17 }), {
          args: ["--dbname", url, "-v", "ON_ERROR_STOP=1", "-Atc", query],
          stdout: (bytes) => Effect.sync(() => void (stdout += new TextDecoder().decode(bytes))),
          stderr: (bytes) => Effect.sync(() => void (stderr += new TextDecoder().decode(bytes))),
        });
        if (result.exitCode !== 0)
          return yield* new BenchmarkError({
            message: `psql exited ${result.exitCode}: ${stderr}`,
          });
        return stdout.trim();
      });
    const source = yield* database();
    const metadata = {
      kind: "metadata",
      filesystem,
      dataset,
      reps,
      warmups: 1,
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      node: process.version,
      root,
      stateRoot,
      cacheRoot,
      canonicalStateRoot,
      daemonId,
      stateDigest,
      volume,
      volumeDirectory: volumeDirectory ?? null,
      dockerInfo: yield* checked(["info", "--format", "{{json .}}"]).pipe(
        Effect.map((value) => value),
      ),
      dockerVersion: yield* checked(["version", "--format", "{{json .}}"]).pipe(
        Effect.map((value) => value),
      ),
      filesystemStat: {
        root: yield* statFilesystem(root),
        stateRoot: yield* statFilesystem(stateRoot),
        cacheRoot: yield* statFilesystem(cacheRoot),
        volumeDirectory:
          volumeDirectory === undefined ? null : yield* statFilesystem(volumeDirectory),
      },
      filesystemTable: yield* filesystemTable,
      volumeInspect: null,
    };
    yield* Console.log(JSON.stringify(metadata));
    const measurements: Array<{
      readonly saveMs: number;
      readonly restoreMs: number;
      readonly startReadyMs: number;
      readonly stopMs: number;
      readonly destroyMs: number;
      readonly warmup: boolean;
    }> = [];

    const reflinkProbe = yield* command([
      "run",
      "--rm",
      "--mount",
      `type=volume,src=${volume},dst=/store`,
      helperImage,
      "/bin/sh",
      "-c",
      "set -eu; rm -f /store/.snapshot-reflink-a /store/.snapshot-reflink-b; printf probe > /store/.snapshot-reflink-a; cp --reflink=always /store/.snapshot-reflink-a /store/.snapshot-reflink-b; cmp /store/.snapshot-reflink-a /store/.snapshot-reflink-b; rm -f /store/.snapshot-reflink-a /store/.snapshot-reflink-b",
    ]);
    yield* Console.log(JSON.stringify({ kind: "reflink-probe", result: reflinkProbe }));

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* source.start;
        yield* source.ready;
        const markerPath = path.join(
          stateRoot,
          stack.id,
          "data",
          source.id,
          ".supabase-database-storage.json",
        );
        yield* Console.log(
          JSON.stringify({
            kind: "store",
            filesystem,
            dataset,
            markerPath,
            marker: yield* fs.readFileString(markerPath),
            volumeInspect: yield* checked(["volume", "inspect", volume]),
          }),
        );
        const url = (yield* source.credentials({ from: "runtime" })).databaseUrl;
        if (url === undefined) return yield* new BenchmarkError({ message: "source URL absent" });
        yield* sql(url, populate);
        const expected = yield* sql(url, check);
        if (!(dataset === "small" ? expectedSmall : expectedLarge).test(expected))
          return yield* new BenchmarkError({ message: `Invalid fixture checksum: ${expected}` });
        yield* source.stop;
        const key = `production-benchmark-${filesystem}-${dataset}`;
        for (let iteration = 0; iteration <= reps; iteration += 1) {
          const target = yield* database();
          const save = yield* measure(source.saveSnapshot(key));
          const restore = yield* measure(target.restoreSnapshot(key));
          if (!restore.value)
            return yield* new BenchmarkError({ message: "restore unexpectedly missed" });
          const startReady = yield* measure(
            Effect.gen(function* () {
              yield* target.start;
              yield* target.ready;
            }),
          );
          const restoredUrl = (yield* target.credentials({ from: "runtime" })).databaseUrl;
          if (restoredUrl === undefined || (yield* sql(restoredUrl, check)) !== expected)
            return yield* new BenchmarkError({ message: "SQL checksum mismatch" });
          const stop = yield* measure(target.stop);
          const destroy = yield* measure(target.destroy);
          const measurement = {
            saveMs: save.ms,
            restoreMs: restore.ms,
            startReadyMs: startReady.ms,
            stopMs: stop.ms,
            destroyMs: destroy.ms,
            warmup: iteration === 0,
          };
          measurements.push(measurement);
          yield* Console.log(
            JSON.stringify({
              kind: "measurement",
              filesystem,
              dataset,
              iteration,
              warmup: iteration === 0,
              saveMs: save.ms,
              restoreMs: restore.ms,
              startReadyMs: startReady.ms,
              stopMs: stop.ms,
              destroyMs: destroy.ms,
              verified: expected,
            }),
          );
        }
      }),
      measure(stack.destroy).pipe(
        Effect.flatMap((result) =>
          Console.log(JSON.stringify({ kind: "ownerCleanup", filesystem, dataset, ms: result.ms })),
        ),
        Effect.ignore,
      ),
    );
    const cleanup = yield* command(["volume", "rm", "-f", volume]);
    if (cleanup.code !== 0 && !cleanup.stderr.includes("No such volume"))
      return yield* new BenchmarkError({ message: `volume cleanup failed: ${cleanup.stderr}` });
    const median = (values: ReadonlyArray<number>) => {
      const sorted = values.toSorted((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : (sorted[middle] ?? 0);
    };
    const measured = measurements.filter((row) => !row.warmup);
    yield* Console.log(
      JSON.stringify({
        kind: "summary",
        filesystem,
        dataset,
        reps: measured.length,
        saveMs: median(measured.map((row) => row.saveMs)),
        restoreMs: median(measured.map((row) => row.restoreMs)),
        startReadyMs: median(measured.map((row) => row.startReadyMs)),
        stopMs: median(measured.map((row) => row.stopMs)),
        destroyMs: median(measured.map((row) => row.destroyMs)),
      }),
    );
    yield* Console.log(JSON.stringify({ kind: "complete", filesystem, dataset, root }));
  }),
);

Effect.runPromise(
  Effect.provide(
    program,
    Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp),
  ) as Effect.Effect<void, unknown, never>,
).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
