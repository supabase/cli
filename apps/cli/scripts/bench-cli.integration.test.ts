import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer, Ref } from "effect";
import { FetchHttpClient } from "effect/http";
import { startReplayServer } from "../../cli-e2e/src/server/replay-server.ts";
import {
  LAUNCH_TIMEOUT_EXIT_CODE,
  prepareArtifacts,
  runLaunch,
  runWorkloadBench,
  type BenchOptions,
} from "./bench-cli.ts";
import { analyzeWorkload, collectFlags, type Workload } from "./bench-report.ts";

const fixturesDir = new URL("../../cli-e2e/fixtures", import.meta.url).pathname;

const baseOptions = (binary: string, overrides: Partial<BenchOptions> = {}): BenchOptions => ({
  base: binary,
  branch: binary,
  runs: 2,
  warmup: 1,
  runsExplicit: false,
  warmupExplicit: false,
  commands: [],
  workloadsFile: undefined,
  only: undefined,
  runtime: undefined,
  artifactCache: undefined,
  cwdSetupInit: false,
  apiUrl: undefined,
  trace: false,
  json: false,
  out: undefined,
  cpuProf: false,
  updateCheck: false,
  ...overrides,
});

// Stands in for a CLI build: every launch makes one request to the profile's API and, when asked
// to trace, records it as an HTTP client span.
const FAKE_CLI = `#!/bin/sh
URL=$(sed -n 's/^api_url: "\\(.*\\)"$/\\1/p' "$SUPABASE_PROFILE")
curl -s -o /dev/null "$URL/v1/projects"
if [ -n "$SUPABASE_TRACE_FILE" ]; then
  PORT=\${URL##*:}
  printf '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"t","spanId":"s","name":"GET","startTimeUnixNano":"0","endTimeUnixNano":"1000000","status":{"code":1},"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"url.path","value":{"stringValue":"/v1/projects"}},{"key":"server.address","value":{"stringValue":"127.0.0.1"}},{"key":"server.port","value":{"intValue":%s}},{"key":"http.response.status_code","value":{"intValue":200}}]}]}]}]}\\n' "$PORT" >> "$SUPABASE_TRACE_FILE"
fi
`;

// Stands in for a stack-aware CLI build. It logs every call with the launch environment, hangs on
// `slow`, and reports one container call per launch when traced.
const LOGGING_CLI = `#!/bin/sh
LOG="$(dirname "$0")/calls.log"
echo "$(basename "$0") $* stack=\${SUPABASE_EXPERIMENTAL_STACK:-} dnt=\${DO_NOT_TRACK:-} tel=\${SUPABASE_TELEMETRY_DISABLED:-} home=\${SUPABASE_HOME:-} cwd=$PWD" >> "$LOG"
case "$1" in
  slow) exec /bin/sleep 30 ;;
  check) if [ -f supabase/seed.sql ]; then echo "fixture present" >> "$LOG"; fi ;;
  cache) if [ -L "$SUPABASE_HOME/cache/stack" ]; then echo "cache linked to $(readlink "$SUPABASE_HOME/cache/stack")" >> "$LOG"; fi ;;
esac
if [ -n "$SUPABASE_TRACE_FILE" ]; then
  printf '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"t","spanId":"s","name":"ContainerCli.spawn","startTimeUnixNano":"0","endTimeUnixNano":"1000000","status":{"code":1},"attributes":[{"key":"process.subcommand","value":{"stringValue":"container inspect"}}]}]}]}]}\\n' >> "$SUPABASE_TRACE_FILE"
fi
exit 0
`;

interface Call {
  readonly build: string;
  readonly command: string;
  readonly stack: string;
  readonly dnt: string;
  readonly tel: string;
  readonly home: string;
  readonly cwd: string;
}

const parseCalls = (log: string): ReadonlyArray<Call> =>
  log.split("\n").flatMap((line) => {
    const match = /^(\S+) (.*) stack=(\S*) dnt=(\S*) tel=(\S*) home=(\S*) cwd=(\S*)$/u.exec(line);
    return match === null
      ? []
      : [
          {
            build: match[1]!,
            command: match[2]!,
            stack: match[3]!,
            dnt: match[4]!,
            tel: match[5]!,
            home: match[6]!,
            cwd: match[7]!,
          },
        ];
  });

/** Two stand-in builds sharing one call log, so the order of launches across builds is visible. */
const makeBuilds = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bench-logging-cli-" });
  for (const name of ["base", "branch"]) {
    yield* fs.writeFileString(`${dir}/${name}`, LOGGING_CLI);
    yield* fs.chmod(`${dir}/${name}`, 0o755);
  }
  const calls = Effect.map(
    fs.readFileString(`${dir}/calls.log`).pipe(Effect.orElseSucceed(() => "")),
    (text) => text,
  );
  return { dir, base: `${dir}/base`, branch: `${dir}/branch`, calls };
});

const stackWorkload = (overrides: Partial<Workload> = {}): Workload => ({
  id: "w",
  args: ["work"],
  cwdSetup: "none",
  stack: true,
  runtime: "docker",
  ...overrides,
});

describe("runWorkloadBench", () => {
  it.effect("counts only the measured launch's API calls, not setup or earlier launches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const server = yield* Effect.acquireRelease(
          Effect.promise(() => startReplayServer({ fixturesDir })),
          (handle) => Effect.promise(() => handle.stop()),
        );
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bench-fake-cli-" });
        const binary = `${dir}/supabase`;
        yield* fs.writeFileString(binary, FAKE_CLI);
        yield* fs.chmod(binary, 0o755);

        const { report } = yield* runWorkloadBench(
          baseOptions(binary, { apiUrl: server.url, trace: true }),
          {
            id: "w",
            args: ["projects", "list"],
            cwdSetup: "init",
            scenario: "projects-list-renders-project-list",
          },
          yield* Ref.make(false),
        );

        const samples = [...report.base, ...report.branch];
        expect(samples).toHaveLength(4);
        for (const sample of samples) {
          expect(sample.exitCode).toBe(0);
          expect(sample.trace?.api?.apiCalls).toBe(1);
          expect(sample.trace?.api?.requestLogCount).toBe(1);
          expect(sample.trace?.api?.externalCalls).toBe(0);
        }
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
  );

  it.effect(
    "runs setup, the launch and teardown in one directory and home per run-scoped unit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const builds = yield* makeBuilds;

          const { report } = yield* runWorkloadBench(
            baseOptions(builds.base, { branch: builds.branch, runs: 1, warmup: 1 }),
            stackWorkload({
              setup: [["boot"]],
              teardown: [["halt"]],
            }),
            yield* Ref.make(false),
          );

          const calls = parseCalls(yield* builds.calls);
          expect(report.base).toHaveLength(1);
          expect(report.branch).toHaveLength(1);
          // Warmup and measured iteration, base and branch each: four units of three calls.
          expect(calls.map((call) => call.command)).toEqual(
            Array.from({ length: 4 }, () => ["boot", "work", "halt"]).flat(),
          );
          for (let unit = 0; unit < 4; unit++) {
            const [setup, launch, teardown] = calls.slice(unit * 3, unit * 3 + 3);
            expect(launch?.home).toBe(setup?.home);
            expect(teardown?.home).toBe(setup?.home);
            expect(launch?.cwd).toBe(setup?.cwd);
          }
          expect(new Set(calls.map((call) => call.home)).size).toBe(4);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
  );

  it.effect("starts one stack per block of launches and alternates the builds between blocks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const builds = yield* makeBuilds;

        const { report } = yield* runWorkloadBench(
          baseOptions(builds.base, { branch: builds.branch, runs: 6, warmup: 1 }),
          stackWorkload({ setupScope: "block", setup: [["boot"]], teardown: [["halt"]] }),
          yield* Ref.make(false),
        );

        const calls = parseCalls(yield* builds.calls);
        expect(report.base).toHaveLength(6);
        expect(report.branch).toHaveLength(6);
        const boots = calls.filter((call) => call.command === "boot");
        expect(boots.map((call) => call.build)).toEqual(["base", "branch", "branch", "base"]);
        expect(calls.filter((call) => call.command === "halt")).toHaveLength(4);
        // One warmup plus five measured launches share the first block's stack.
        const firstBlock = calls.filter((call) => call.home === boots[0]?.home);
        expect(firstBlock.map((call) => call.command)).toEqual([
          "boot",
          ...Array.from({ length: 6 }, () => "work"),
          "halt",
        ]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
  );

  it.effect("opens stack mode only for stack workloads and never lets telemetry through", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const builds = yield* makeBuilds;
        const run = (workload: Workload) =>
          runWorkloadBench(
            baseOptions(builds.base, { branch: builds.branch, runs: 1, warmup: 0 }),
            workload,
            Ref.make(false).pipe(Effect.runSync),
          );

        yield* run(stackWorkload({ id: "stack", args: ["on"], setup: [["boot"]] }));
        yield* run({ id: "plain", args: ["off"], cwdSetup: "none" });

        const calls = parseCalls(yield* builds.calls);
        for (const call of calls) {
          expect(call.dnt).toBe("1");
          expect(call.tel).toBe("1");
        }
        expect(
          calls
            .filter((call) => ["boot", "on"].includes(call.command))
            .every((call) => call.stack === "1"),
        ).toBe(true);
        expect(
          calls.filter((call) => call.command === "off").every((call) => call.stack === ""),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
  );

  it.live("runs teardown after a launch that outlives its timeout and records the timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const builds = yield* makeBuilds;

        const { report } = yield* runWorkloadBench(
          baseOptions(builds.base, { branch: builds.branch, runs: 1, warmup: 0 }),
          stackWorkload({ args: ["slow"], teardown: [["halt"]], timeoutSeconds: 1 }),
          yield* Ref.make(false),
        );

        const commands = parseCalls(yield* builds.calls).map((call) => call.command);
        expect(commands).toEqual(["slow", "halt", "slow", "halt"]);
        expect(report.base[0]?.exitCode).toBe(LAUNCH_TIMEOUT_EXIT_CODE);
        expect(report.branch[0]?.exitCode).toBe(LAUNCH_TIMEOUT_EXIT_CODE);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
  );

  it.effect(
    "copies the workload's fixture into the project and links the shared artifact cache into every home",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const builds = yield* makeBuilds;
          const manifestDir = yield* fs.makeTempDirectoryScoped({ prefix: "bench-manifest-" });
          yield* fs.makeDirectory(`${manifestDir}/fixtures/seeded`, { recursive: true });
          yield* fs.writeFileString(`${manifestDir}/fixtures/seeded/seed.sql`, "select 1;");
          const cache = yield* fs.makeTempDirectoryScoped({ prefix: "bench-cache-" });

          yield* runWorkloadBench(
            baseOptions(builds.base, {
              branch: builds.branch,
              runs: 1,
              warmup: 0,
              workloadsFile: `${manifestDir}/workloads.json`,
              artifactCache: cache,
            }),
            stackWorkload({ args: ["check"], setup: [["cache"]], fixture: "seeded" }),
            yield* Ref.make(false),
          );

          const log = yield* builds.calls;
          expect(log.match(/fixture present/gu)).toHaveLength(2);
          expect(log.match(new RegExp(`cache linked to ${cache}`, "gu"))).toHaveLength(2);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
  );

  it.effect(
    "traces only the workload's traceRuns launches per build and reports container calls from them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const builds = yield* makeBuilds;

          const { report } = yield* runWorkloadBench(
            baseOptions(builds.base, { branch: builds.branch, runs: 3, warmup: 0, trace: true }),
            { id: "w", args: ["work"], cwdSetup: "none", traceRuns: 1 },
            yield* Ref.make(false),
          );

          for (const samples of [report.base, report.branch]) {
            expect(samples.map((sample) => sample.trace !== undefined)).toEqual([
              true,
              false,
              false,
            ]);
          }
          const analysis = analyzeWorkload(report, true);
          expect(analysis.base.containers).toEqual({ "container inspect": 1 });
          expect(collectFlags(analysis).map((flag) => flag.kind)).not.toContain("trace-incomplete");
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
  );
});

describe("prepareArtifacts", () => {
  it.effect("installs each stack runtime once per build and skips default-mode workloads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const builds = yield* makeBuilds;

        yield* prepareArtifacts(baseOptions(builds.base, { branch: builds.branch }), [
          stackWorkload({ id: "a", runtime: "native" }),
          stackWorkload({ id: "b", runtime: "native" }),
          stackWorkload({ id: "c", runtime: "docker" }),
          { id: "plain", args: ["start"], cwdSetup: "none", runtime: "docker" },
        ]);

        const installs = parseCalls(yield* builds.calls)
          .filter((call) => call.command !== "init")
          .map((call) => `${call.build}: ${call.command}`);
        expect(installs).toEqual([
          "base: stack install --runtime docker",
          "base: stack install --runtime native",
          "branch: stack install --runtime docker",
          "branch: stack install --runtime native",
        ]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
  );
});

describe("runLaunch", () => {
  it.live("kills a launch that outlives the timeout and records a failing exit code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bench-hung-cli-" });
        const pidFile = `${dir}/pid`;
        const binary = `${dir}/supabase`;
        yield* fs.writeFileString(
          binary,
          `#!/bin/sh\necho $$ > "${pidFile}"\nexec /bin/sleep 60\n`,
        );
        yield* fs.chmod(binary, 0o755);

        const result = yield* runLaunch({
          binary,
          args: [],
          cwd: dir,
          env: {},
          timeout: Duration.millis(500),
        });

        expect(result.exitCode).toBe(LAUNCH_TIMEOUT_EXIT_CODE);
        expect(result.wallMs).toBeLessThan(30_000);
        const pid = Number((yield* fs.readFileString(pidFile)).trim());
        expect(Number.isInteger(pid)).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );
});
