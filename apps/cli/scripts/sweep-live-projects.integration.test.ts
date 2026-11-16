import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Data,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
} from "effect";

// Per-sweep hang guard: a spawned run gets this long before the safety net kills
// it. A test's own timeout must cover every sweep it runs plus report margin, so
// derive it from the sweep count rather than a single shared budget.
const SWEEP_GUARD_MS = 30_000;
const REPORT_MARGIN_MS = 10_000;
const sweepBudget = (sweeps: number) => sweeps * SWEEP_GUARD_MS + REPORT_MARGIN_MS;

class SweepHarnessFailed extends Data.TaggedError("SweepHarnessFailed")<{
  readonly cause: unknown;
}> {}

const sweepLayer = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  ConfigProvider.layer(ConfigProvider.fromEnvRecord(process.env, { preserveEmptyStrings: true })),
);

const provideSweep = <A, R>(
  sweep: Effect.Effect<A, Config.ConfigError | PlatformError.PlatformError | SweepHarnessFailed, R>,
) =>
  sweep.pipe(
    Effect.catchTags({
      PlatformError: (error) => Effect.die(error.cause ?? error),
      SweepHarnessFailed: (error) => Effect.die(error.cause),
    }),
    Effect.provide(sweepLayer),
  );

type Scenario = {
  lists: Array<unknown> | ((deletes: ReadonlyArray<string>) => unknown);
  deletes: Record<string, { status: number; body?: unknown }>;
  deleteStatuses?: Record<string, Array<number>>;
};

const readText = (stream: ReadableStream<Uint8Array>) =>
  Effect.tryPromise({
    try: () => new Response(stream).text(),
    catch: (cause) => new SweepHarnessFailed({ cause }),
  });

const runSweep = Effect.fnUntraced(function* (scenario: Scenario) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const script = path.resolve(import.meta.dirname, "sweep-live-projects.sh");
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "sweep-live-projects-" });
  const fakeSleep = path.join(directory, "sleep");
  yield* fs.writeFileString(fakeSleep, "#!/bin/sh\nexit 0\n");
  yield* fs.chmod(fakeSleep, 0o755);

  let listIndex = 0;
  const deletes: string[] = [];
  const serve = () =>
    Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const ref = url.pathname.split("/").pop() ?? "";
        if (request.method === "GET" && url.pathname === "/v1/projects") {
          const value =
            typeof scenario.lists === "function"
              ? scenario.lists(deletes)
              : scenario.lists[Math.min(listIndex++, scenario.lists.length - 1)];
          return typeof value === "number"
            ? new Response("temporary failure", { status: value })
            : Response.json(value);
        }
        if (request.method === "DELETE" && url.pathname.startsWith("/v1/projects/")) {
          deletes.push(ref);
          const statuses = scenario.deleteStatuses?.[ref];
          const result: { status: number; body?: unknown } =
            statuses === undefined
              ? (scenario.deletes[ref] ?? { status: 404 })
              : {
                  status:
                    statuses[
                      Math.min(
                        deletes.filter((value) => value === ref).length - 1,
                        statuses.length - 1,
                      )
                    ] ?? 500,
                };
          return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
            status: result.status,
            headers: { "x-request-id": `delete-${ref}` },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
  return yield* Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.try({ try: serve, catch: (cause) => new SweepHarnessFailed({ cause }) }),
      (server) => Effect.promise(() => server.stop(true)),
    );
    const inheritedPath = yield* Config.option(Config.String("PATH"));
    const child = yield* Effect.try({
      try: () =>
        Bun.spawn(["bash", script, "e2e-"], {
          env: {
            ...globalThis.process.env,
            PATH: `${directory}:${Option.getOrUndefined(inheritedPath)}`,
            SUPABASE_ACCESS_TOKEN: "test-token",
            SUPABASE_LIVE_API_URL: `http://127.0.0.1:${server.port}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: (cause) => new SweepHarnessFailed({ cause }),
    });
    let hung = false;
    const guard = yield* Effect.sleep(SWEEP_GUARD_MS).pipe(
      Effect.andThen(
        Effect.sync(() => {
          hung = true;
          child.kill();
        }),
      ),
      Effect.forkChild,
    );
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [Effect.promise(() => child.exited), readText(child.stdout), readText(child.stderr)],
      { concurrency: "unbounded" },
    );
    yield* Fiber.interrupt(guard);
    if (hung) {
      return yield* Effect.die(
        new Error(
          `sweep script hung: killed after ${SWEEP_GUARD_MS}ms without exiting (stdout: ${stdout}, stderr: ${stderr})`,
        ),
      );
    }
    return { exitCode, stdout, stderr, deletes };
  }).pipe(Effect.scoped);
}, provideSweep);

const active = (ref: string, name = `e2e-${ref}`) => ({ ref, name, status: "ACTIVE" });

describe.skipIf(process.platform === "win32")(
  "sweep-live-projects.sh",
  { timeout: sweepBudget(1) },
  () => {
    it.live("accepts refused deletion when a fresh authenticated list shows absence", () =>
      Effect.gen(function* () {
        const result = yield* runSweep({
          lists: [[active("gone")], []],
          deletes: { gone: { status: 403, body: { message: "already removed" } } },
        });
        expect(result.exitCode).toBe(0);
        expect(result.deletes).toEqual(["gone"]);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain("test-token");
      }),
    );

    it.live("accepts a terminal status and converges after a stale list", () =>
      Effect.gen(function* () {
        const result = yield* runSweep({
          lists: [
            [active("stale")],
            [active("stale")],
            [{ ...active("stale"), status: "REMOVED" }],
          ],
          deletes: { stale: { status: 202 } },
        });
        expect(result.exitCode).toBe(0);
      }),
    );

    it.live(
      "retries a transient read failure but rejects malformed evidence",
      () =>
        Effect.gen(function* () {
          const transient = yield* runSweep({
            lists: [503, [active("retry")], []],
            deletes: { retry: { status: 202 } },
          });
          expect(transient.exitCode).toBe(0);

          const malformed = yield* runSweep({ lists: [{ projects: [] }], deletes: {} });
          expect(malformed.exitCode).not.toBe(0);
          expect(malformed.deletes).toEqual([]);
        }),
      sweepBudget(2),
    );

    it.live(
      "fails terminal listing errors without retrying or deleting",
      () =>
        Effect.gen(function* () {
          const forbidden = yield* runSweep({ lists: [403, []], deletes: {} });
          expect(forbidden.exitCode).not.toBe(0);
          expect(forbidden.deletes).toEqual([]);

          const unavailable = yield* runSweep({ lists: [503, 503, 503], deletes: {} });
          expect(unavailable.exitCode).not.toBe(0);
          expect(unavailable.deletes).toEqual([]);

          const malformedReconciliation = yield* runSweep({
            lists: [[active("bad-evidence")], { projects: [] }],
            deletes: { "bad-evidence": { status: 403 } },
          });
          expect(malformedReconciliation.exitCode).not.toBe(0);
        }),
      sweepBudget(3),
    );

    it.live("attempts every owned project and fails if one remains active", () =>
      Effect.gen(function* () {
        const result = yield* runSweep({
          lists: [
            [
              active("stuck"),
              active("other"),
              { ref: "foreign", name: "unrelated", status: "ACTIVE" },
            ],
            [active("stuck"), { ref: "foreign", name: "unrelated", status: "ACTIVE" }],
          ],
          deletes: { stuck: { status: 403 }, other: { status: 204 } },
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.deletes).toEqual(["stuck", "other"]);
      }),
    );

    it.live("retries a transient deletion after fresh evidence still shows the project", () =>
      Effect.gen(function* () {
        const result = yield* runSweep({
          lists: (deletes) => (deletes.length >= 2 ? [] : [active("flaky")]),
          deletes: {},
          deleteStatuses: { flaky: [503, 204] },
        });
        expect(result.exitCode).toBe(0);
        expect(result.deletes).toEqual(["flaky", "flaky"]);
        expect(result.stderr).toContain(
          "delete retry completed for project flaky (HTTP 204 request delete-flaky)",
        );
      }),
    );
  },
);
