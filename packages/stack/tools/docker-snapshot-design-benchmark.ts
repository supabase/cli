import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import {
  Clock,
  Console,
  Crypto,
  Data,
  DateTime,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeDatabaseSnapshots } from "../src/services/DatabaseSnapshot.ts";
import { makeDockerSnapshotSession } from "../src/services/DatabaseSnapshotDockerSession.ts";
import { makeDockerDirectorySession } from "../src/services/DatabaseSnapshotDockerDirectory.ts";

class BenchmarkError extends Data.TaggedError("BenchmarkError")<{ readonly message: string }> {}
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const flag = (name: string, fallback: string) =>
  process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const reps = Number(flag("reps", "5"));
const warmups = Number(flag("warmups", "1"));
const image =
  "ghcr.io/supabase/cli/postgres:17.6.1.173@sha256:1581c433d71a48a81e356a3ed2d4aa5ecfc8fc0465ea98661da7a88023317dcf";
const variants = [
  "baseline",
  "bind-one",
  "bind-shared",
  "volume-one",
  "volume-shared-clone",
  "volume-shared-copy",
] as const;
type Variant = (typeof variants)[number];
type Mount = { readonly kind: "bind" | "volume"; readonly source: string };
type Dataset = "small" | "large";
const selected = variants.filter((v) => flag("variant", variants.join(",")).split(",").includes(v));
const datasets = (["small", "large"] as const).filter((v) =>
  flag("dataset", "small,large").split(",").includes(v),
);
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const populate = (dataset: Dataset) =>
  dataset === "small"
    ? "CREATE TABLE snapshot_users (id integer PRIMARY KEY, email text NOT NULL, display_name text NOT NULL); INSERT INTO snapshot_users SELECT i,'user-'||i||'@example.test','Benchmark User '||i FROM generate_series(1,24) AS i; CREATE TABLE snapshot_events (id integer PRIMARY KEY,user_id integer NOT NULL REFERENCES snapshot_users(id),kind text NOT NULL,payload jsonb NOT NULL); INSERT INTO snapshot_events SELECT i,((i-1)%24)+1,CASE WHEN i%2=0 THEN 'login' ELSE 'purchase' END,jsonb_build_object('sequence',i,'source','benchmark') FROM generate_series(1,96) AS i;"
    : "CREATE TABLE snapshot_large (id integer PRIMARY KEY,payload text NOT NULL); ALTER TABLE snapshot_large ALTER COLUMN payload SET STORAGE EXTERNAL; INSERT INTO snapshot_large SELECT i,(SELECT string_agg(md5('snapshot-large-'||i||':'||j),'' ORDER BY j) FROM generate_series(1,256) AS j) FROM generate_series(1,32768) AS i;";
const validate = (dataset: Dataset) =>
  dataset === "small"
    ? "SELECT (SELECT count(*) FROM snapshot_users), (SELECT count(*) FROM snapshot_events), (SELECT email FROM snapshot_users WHERE id=24)"
    : "SELECT count(*),sum(length(payload)),md5(string_agg(md5(payload),'' ORDER BY id)) FROM snapshot_large";
const mountArg = (mount: Mount) => `type=${mount.kind},source=${mount.source},target=/workspace`;
const command = (args: readonly string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(ChildProcess.make("docker", args, { stdin: "ignore" }));
      const read = (stream: typeof child.stdout) =>
        stream.pipe(
          Stream.decodeText,
          Stream.runFold(
            () => "",
            (a, b) => (a + b).slice(-1024 * 1024),
          ),
        );
      const [stdout, stderr, code] = yield* Effect.all(
        [read(child.stdout), read(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0)
        return yield* new BenchmarkError({
          message: `docker ${args.slice(0, 2).join(" ")} exited ${code}: ${stderr}`,
        });
      return stdout.trim();
    }),
  );
const helper = (mount: Mount, script: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const id = yield* Effect.acquireRelease(
        command([
          "create",
          "--mount",
          mountArg(mount),
          "--entrypoint",
          "/usr/bin/busybox",
          image,
          "sh",
          "-c",
          script,
        ]),
        (id) => command(["rm", "-f", id]).pipe(Effect.ignore),
      );
      return yield* command(["start", "--attach", id]);
    }),
  );
const sql = (id: string, statement: string) =>
  command([
    "exec",
    id,
    "/opt/postgres/bin/psql",
    "-h",
    "/tmp",
    "-U",
    "supabase_admin",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
    "-c",
    statement,
  ]);
const startDatabase = (mount: Mount, instance: string) =>
  Effect.gen(function* () {
    const started = performance.now();
    const path = yield* Path.Path;
    const dataMount =
      mount.kind === "volume"
        ? `type=volume,source=${mount.source},target=/var/lib/postgresql/data,volume-subpath=${instance}/data`
        : `type=bind,source=${path.join(mount.source, instance, "data")},target=/var/lib/postgresql/data`;
    const id = yield* Effect.acquireRelease(
      command([
        "create",
        "--mount",
        dataMount,
        "--env",
        "PGDATA=/var/lib/postgresql/data",
        "--env",
        "PGSODIUM_KEY_FILE=/var/lib/postgresql/data/pgsodium_root.key",
        "--env",
        "POSTGRES_USER=supabase_admin",
        "--env",
        "POSTGRES_DB=postgres",
        "--env",
        "POSTGRES_PASSWORD=snapshot-benchmark-password",
        "--health-cmd",
        "/usr/bin/busybox grep -aq .postgres-portable-real /proc/1/cmdline && /opt/postgres/bin/pg_isready -U supabase_admin -d postgres",
        "--health-interval",
        "100ms",
        "--health-timeout",
        "3s",
        "--health-retries",
        "1200",
        image,
        "-p",
        "5432",
        "-c",
        "listen_addresses=*",
      ]),
      (id) => command(["rm", "-f", id]).pipe(Effect.ignore),
    );
    const since = String(Math.floor((yield* Clock.currentTimeMillis) / 1000) - 1);
    const healthy = Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const events = yield* spawner.spawn(
          ChildProcess.make(
            "docker",
            [
              "events",
              "--since",
              since,
              "--filter",
              `container=${id}`,
              "--filter",
              "event=health_status",
              "--format",
              "{{.Action}}",
            ],
            { stdin: "ignore" },
          ),
        );
        const result = yield* events.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.filter((line) => line === "health_status: healthy"),
          Stream.runHead,
        );
        if (Option.isNone(result))
          return yield* new BenchmarkError({ message: "Docker health event stream ended" });
      }),
    );
    const ready = yield* healthy.pipe(Effect.forkChild);
    yield* command(["start", id]);
    yield* Fiber.join(ready).pipe(
      Effect.timeout("120 seconds"),
      Effect.tapError(() => command(["logs", "--tail", "40", id]).pipe(Effect.tap(Console.error))),
    );
    yield* sql(id, "SELECT 1");
    return {
      id,
      startReadyMs: performance.now() - started,
      stop: command(["stop", "--time", "30", id]),
    };
  });
type Row = {
  kind: "measurement";
  dataset: Dataset;
  variant: Variant;
  repetition: number;
  warmup: boolean;
  setupMs: number;
  teardownMs: number;
  exportMs: number;
  restoreMs: number;
  startReadyMs: number;
  phases: { phase: string; milliseconds: number }[];
};
const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { join, resolve } = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const out = resolve(flag("out", "/tmp/docker-snapshot-design-results"));
    yield* fs.makeDirectory(out, { recursive: true });
    const rows: Row[] = [];
    const metadata = {
      kind: "metadata",
      at: DateTime.formatIso(yield* DateTime.now),
      platform: process.platform,
      arch: process.arch,
      reps,
      warmups,
      image,
      docker: yield* command(["info", "--format", "{{json .}}"]),
      notes:
        "Warm images and filesystem caches. SQL-verified real PostgreSQL fixtures. Start-ready includes container create/start, health event and SELECT 1; excludes full stack role reconciliation. Cleanup and validation SQL excluded from snapshot times.",
    };
    yield* fs.writeFileString(join(out, "metadata.json"), yield* json(metadata));
    yield* Console.log(yield* json(metadata));
    for (const dataset of datasets) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-snapshot-design-" });
          const volume = `snapshot-design-${yield* crypto.randomUUIDv4}`;
          yield* Effect.acquireRelease(command(["volume", "create", volume]), () =>
            command(["volume", "rm", volume]).pipe(Effect.ignore),
          );
          const mounts: Mount[] = [];
          if (selected.some((v) => !v.startsWith("volume")))
            mounts.push({ kind: "bind", source: root });
          if (selected.some((v) => v.startsWith("volume")))
            mounts.push({ kind: "volume", source: volume });
          const expected = new Map<string, string>();
          for (const mount of mounts) {
            yield* Console.error(`Prepare ${dataset}/${mount.kind}`);
            yield* helper(
              mount,
              "mkdir -p /workspace/source/data && chown -R 100:101 /workspace/source",
            );
            const source = yield* startDatabase(mount, "source");
            yield* sql(source.id, populate(dataset));
            const value = yield* sql(source.id, validate(dataset));
            if (
              (dataset === "small" && value !== "24|96|user-24@example.test") ||
              (dataset === "large" && !value.startsWith("32768|268435456|"))
            )
              return yield* new BenchmarkError({ message: `Invalid fixture: ${value}` });
            expected.set(mount.kind, value);
            yield* source.stop;
            if (mount.kind === "bind")
              yield* fs.writeFileString(
                join(root, "source", ".supabase-database-ready.json"),
                yield* json({ version: "17.6.1.173", runtime: "docker", profile: "supabase" }),
              );
            const size = yield* helper(mount, "/usr/bin/busybox du -sk /workspace/source/data");
            yield* Console.log(
              yield* json({
                kind: "fixture",
                dataset,
                mount: mount.kind,
                size,
                expected: value,
              }),
            );
          }
          if (mounts.some((m) => m.kind === "volume")) {
            const supported = yield* Effect.scoped(
              Effect.gen(function* () {
                const session = yield* makeDockerDirectorySession({
                  volume,
                  reuse: true,
                  copyMode: "clone",
                });
                return yield* session.probeCloning;
              }),
            );
            yield* Console.log(yield* json({ kind: "clone-probe", dataset, supported }));
          }
          const canonical = new Map<Variant, string>();
          for (let rep = 0; rep < reps + warmups; rep++) {
            const rotated = [
              ...selected.slice(rep % selected.length),
              ...selected.slice(0, rep % selected.length),
            ];
            for (const variant of rotated) {
              const mount: Mount = variant.startsWith("volume")
                ? { kind: "volume", source: volume }
                : { kind: "bind", source: root };
              const target = `target-${variant}-${rep}`;
              const destination =
                mount.kind === "volume"
                  ? `snapshots/${variant}-${rep}`
                  : join(root, `${variant}-${rep}.tar`);
              if (mount.kind === "bind")
                yield* fs.makeDirectory(join(root, target), { recursive: true });
              const options = (instanceId: string) => ({
                instanceRoot: join(root, instanceId),
                runtime: "docker" as const,
                version: "17",
                stackId: "snapshot-design",
                instanceId,
              });
              const phases: Row["phases"] = [];
              yield* Console.error(`Measure ${dataset}/${variant}/${rep}`);
              const sessionStarted = performance.now();
              let operationsFinished = 0;
              const measured = yield* Effect.scoped(
                Effect.gen(function* () {
                  const session =
                    variant === "baseline"
                      ? undefined
                      : variant.startsWith("volume")
                        ? yield* makeDockerDirectorySession({
                            volume,
                            reuse: variant !== "volume-one",
                            copyMode: variant === "volume-shared-copy" ? "copy" : "clone",
                            onPhase: (e) => phases.push(e),
                          })
                        : yield* makeDockerSnapshotSession({
                            root,
                            reuse: variant === "bind-shared",
                            onPhase: (e) => phases.push(e),
                          });
                  const from =
                    variant === "baseline"
                      ? yield* makeDatabaseSnapshots(options("source"))
                      : session !== undefined && "probeCloning" in session
                        ? session.forInstance("source")
                        : session !== undefined
                          ? yield* session.forInstance(options("source"))
                          : yield* makeDatabaseSnapshots(options("source"));
                  const to =
                    variant === "baseline"
                      ? yield* makeDatabaseSnapshots(options(target))
                      : session !== undefined && "probeCloning" in session
                        ? session.forInstance(target)
                        : session !== undefined
                          ? yield* session.forInstance(options(target))
                          : yield* makeDatabaseSnapshots(options(target));
                  const setupMs = performance.now() - sessionStarted;
                  const exportStarted = performance.now();
                  yield* from.exportSnapshot({ destination });
                  const exportMs = performance.now() - exportStarted;
                  const cache = canonical.get(variant) ?? destination;
                  canonical.set(variant, cache);
                  const restoreStarted = performance.now();
                  yield* to.restoreSnapshot({ source: cache });
                  const restoreMs = performance.now() - restoreStarted;
                  operationsFinished = performance.now();
                  return { setupMs, exportMs, restoreMs };
                }),
              );
              const teardownMs = performance.now() - operationsFinished;
              const restored = yield* startDatabase(mount, target);
              const actual = yield* sql(restored.id, validate(dataset));
              if (actual !== expected.get(mount.kind))
                return yield* new BenchmarkError({
                  message: `Restored data mismatch ${dataset}/${variant}: ${actual}`,
                });
              yield* sql(
                restored.id,
                dataset === "small"
                  ? "DELETE FROM snapshot_events; DELETE FROM snapshot_users"
                  : "DELETE FROM snapshot_large WHERE id=1",
              );
              yield* restored.stop;
              yield* command(["rm", restored.id]);
              yield* helper(mount, `rm -rf ${quote(`/workspace/${target}`)}`);
              const row: Row = {
                kind: "measurement",
                dataset,
                variant,
                repetition: rep,
                warmup: rep < warmups,
                ...measured,
                teardownMs,
                startReadyMs: restored.startReadyMs,
                phases,
              };
              rows.push(row);
              yield* Console.log(yield* json(row));
              yield* fs.writeFileString(
                join(out, "measurements.jsonl"),
                (yield* Effect.forEach(rows, (row) => json(row))).join("\n") + "\n",
              );
            }
          }
        }),
      );
    }
    const median = (values: number[]) => {
      const a = values.toSorted((a, b) => a - b);
      const mid = Math.floor(a.length / 2);
      return a.length % 2 ? a[mid] : ((a[mid - 1] ?? 0) + (a[mid] ?? 0)) / 2;
    };
    const summary = datasets.flatMap((dataset) =>
      selected.map((variant) => {
        const group = rows.filter(
          (r) => r.dataset === dataset && r.variant === variant && !r.warmup,
        );
        return {
          dataset,
          variant,
          n: group.length,
          exportMs: median(group.map((r) => r.exportMs)),
          restoreMs: median(group.map((r) => r.restoreMs)),
          setupMs: median(group.map((r) => r.setupMs)),
          teardownMs: median(group.map((r) => r.teardownMs)),
          warmSnapshotMs: median(group.map((r) => r.exportMs + r.restoreMs)),
          coldSnapshotMs: median(
            group.map((r) => r.setupMs + r.exportMs + r.restoreMs + r.teardownMs),
          ),
          coldRestoreMs: median(group.map((r) => r.setupMs + r.restoreMs + r.teardownMs)),
          startReadyMs: median(group.map((r) => r.startReadyMs)),
        };
      }),
    );
    yield* fs.writeFileString(join(out, "summary.json"), yield* json(summary));
    yield* Console.log(yield* json({ kind: "summary", summary }));
  }),
);
Effect.runPromise(
  program.pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
).catch((error: unknown) => {
  Effect.runSync(Console.error(error));
  process.exitCode = 1;
});
