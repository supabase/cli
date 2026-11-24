import { Data, Effect, FileSystem, Path, Stream } from "effect";
import { Buffer } from "node:buffer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { normalizeStdout, type MachineOutput, type MachineFormat } from "./machine-output.ts";

class ScenarioError extends Data.TaggedError("ScenarioError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface Route {
  readonly body: unknown;
  readonly status?: number;
  readonly required?: boolean;
}

export interface ScenarioCase {
  readonly name: string;
  readonly format: MachineFormat;
  readonly exitCode: number;
  readonly routes: Readonly<Record<string, Route>>;
}

export interface Scenario {
  readonly name: string;
  readonly argv: readonly string[];
  readonly cases: readonly ScenarioCase[];
}

export const runCase = Effect.fn("MigrationCompat.runCase")(
  function* (binary: string, scenario: Scenario, testCase: ScenarioCase) {
    const fs = yield* FileSystem.FileSystem;
    const { join } = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "migration-compat-home-" });
    const requests: string[] = [];
    const unexpected = new Set<string>();
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, server) {
            const url = new URL(request.url);
            const key = `${request.method} ${url.pathname}${url.search}`;
            const route = url.origin === server.url.origin ? testCase.routes[key] : undefined;
            if (!route) {
              unexpected.add(key);
              return new Response(null, { status: 404 });
            }
            requests.push(key);
            return Response.json(route.body, { status: route.status });
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    );
    const origin = server.url.origin;
    const profile = join(home, "profile.yaml");
    yield* fs.writeFileString(
      profile,
      `name: migration-compat\napi_url: ${origin}\ndashboard_url: ${origin}\nproject_host: example.invalid\n`,
    );
    const command = ChildProcess.make(
      binary,
      scenario.argv.map((arg) => (arg === "<format>" ? testCase.format : arg)),
      {
        cwd: home,
        stdin: "ignore",
        extendEnv: false,
        env: {
          PATH: home,
          HOME: home,
          TMPDIR: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
          XDG_DATA_HOME: home,
          SUPABASE_HOME: home,
          SUPABASE_PROFILE: profile,
          SUPABASE_ACCESS_TOKEN: `sbp_${"a".repeat(40)}`,
          SUPABASE_NO_UPDATE_NOTIFIER: "1",
          DO_NOT_TRACK: "1",
          NO_COLOR: "1",
          HTTP_PROXY: origin,
          HTTPS_PROXY: origin,
          NO_PROXY: "127.0.0.1",
        },
      },
    );
    const child = yield* spawner.spawn(command);
    const [exitCode, out, err] = yield* Effect.all(
      [child.exitCode, Stream.runCollect(child.stdout), Stream.runCollect(child.stderr)],
      { concurrency: "unbounded" },
    );
    yield* Effect.annotateCurrentSpan({ "process.exit_code": exitCode });
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    const stdout = decoder.decode(Buffer.concat(out));
    const stderr = decoder.decode(Buffer.concat(err));
    const missing = Object.keys(testCase.routes).filter(
      (key) => testCase.routes[key]?.required && !requests.includes(key),
    );
    if (exitCode !== testCase.exitCode || missing.length || unexpected.size) {
      return yield* new ScenarioError({
        message:
          `${scenario.name}/${testCase.name}: expected exit ${testCase.exitCode}, got ${exitCode}; ` +
          `missing requests: ${missing.join(", ") || "none"}; unexpected requests: ${[...unexpected].join(", ") || "none"}\n` +
          `stdout: ${stdout}\nstderr: ${stderr}`,
      });
    }
    yield* Effect.try({
      try: () => normalizeStdout(testCase.format, stdout),
      catch: (cause) =>
        new ScenarioError({
          message: `${scenario.name}/${testCase.name}: invalid stdout: ${stdout}\nstderr: ${stderr}`,
          cause,
        }),
    });
    return { exitCode, stdout, stderr, requests } satisfies MachineOutput;
  },
  Effect.scoped,
  Effect.timeout("30 seconds"),
);
