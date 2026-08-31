/**
 * `db test` is a hidden alias that reuses `test db`'s flag config and
 * assembled handler verbatim (see `test.command.ts`). The core pgTAP
 * enable/disable + `pg_prove` docker-invocation behavior is already
 * exhaustively covered by `../../../shared/legacy-test-db.integration.test.ts` (calling the
 * same `legacyTestDb` this alias ultimately runs), so this file focuses on
 * what is actually NEW/alias-specific:
 *
 * 1. The alias still produces correct behavior end-to-end through
 *    `legacyRunTestDbCommand` (one golden path + one failure path), proving
 *    the delegation itself is wired correctly.
 * 2. The `cli_command_executed` telemetry `command` property records the
 *    ACTUAL invoked path — `"db test"`, not `"test db"` — which differs
 *    between the two entry points even though the handler is identical. This
 *    is proven by dispatching through the REAL exported `legacyDbTestCommand`
 *    (via `Command.runWith` on a minimal root, mirroring
 *    `../../../../shared/cli/hidden-flag.unit.test.ts`'s pattern) rather than
 *    hand-building a runtime layer with a test-supplied `commandPath` — a
 *    regression in `test.command.ts`'s own `legacyTestDbRuntimeLayer(["db",
 *    "test"])` wiring would otherwise silently corrupt product analytics
 *    without failing any test.
 * 3. The non-text branch of `onRunFailure` (json/stream-json: stderr + exit
 *    code 1, no Effect failure) — shared code that had no prior coverage
 *    from either entry point.
 *
 * Mocking follows the same established patterns already used elsewhere in
 * this codebase rather than inventing a new one: the domain-level fakes
 * (`LegacyDbConfigResolver` / `LegacyDbConnection` / `LegacyDockerRun`) mirror
 * `../../../shared/legacy-test-db.integration.test.ts`; the instrumentation-level fakes
 * (`Analytics` reading `CurrentAnalyticsContext`, `Stdio.layerTest`,
 * `commandRuntimeLayer`) mirror `../../../telemetry/legacy-command-instrumentation.unit.test.ts`;
 * and the telemetry-wiring test's ambient layer (satisfying
 * `legacyTestDbRuntimeLayer`'s own requirements so it actually builds) mirrors
 * `../../../shared/legacy-test-db.layers.unit.test.ts`'s `ambientStubs()`.
 */
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stdio } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
} from "../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliSettings,
  mockLegacyTelemetryStateTracked,
  legacySequentialExecBatch,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import {
  LEGACY_GLOBAL_FLAGS,
  LegacyAgentFlag,
  LegacyCreateTicketFlag,
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyOutputFlag,
  LegacyProfileFlag,
  LegacyWorkdirFlag,
  LegacyYesFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { CurrentAnalyticsContext } from "../../../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../../../shared/telemetry/analytics.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import {
  LegacyDockerRun,
  type LegacyDockerRunOpts,
} from "../../../shared/legacy-docker-run.service.ts";
import { LegacyEdgeRuntimeScript } from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { legacyRunTestDbCommand } from "../../../shared/legacy-test-db.command-handler.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { legacyDbCommand } from "../db.command.ts";

const LOCAL_CONN: LegacyPgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

function mockContextualAnalytics() {
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const layer = Layer.succeed(
    Analytics,
    Analytics.of({
      capture: (event: string, properties: Record<string, unknown> = {}) =>
        Effect.gen(function* () {
          const context = yield* CurrentAnalyticsContext;
          captured.push({ event, properties: { ...context, ...properties } });
        }),
      identify: () => Effect.void,
      alias: () => Effect.void,
      groupIdentify: () => Effect.void,
    }),
  );
  return { layer, captured };
}

function mockResolver() {
  return Layer.succeed(LegacyDbConfigResolver, {
    resolve: () => Effect.succeed({ conn: LOCAL_CONN, isLocal: true }),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
}

function mockDbConnection() {
  const execCalls: string[] = [];
  const session: LegacyDbSession = {
    exec: (sql) =>
      Effect.sync(() => {
        execCalls.push(sql);
      }),
    execBatch: (statements) => legacySequentialExecBatch(session)(statements),
    extensionExists: () => Effect.succeed(false),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    query: () => Effect.succeed([]),
  };
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: () => Effect.succeed(session),
  });
  return { layer, execCalls };
}

function mockDockerRun(opts: { exitCode?: number; stdout?: ReadonlyArray<string> } = {}) {
  let lastOpts: LegacyDockerRunOpts | undefined;
  const layer = Layer.succeed(LegacyDockerRun, {
    run: (runOpts) => {
      lastOpts = runOpts;
      return Effect.succeed(opts.exitCode ?? 0);
    },
    runCapture: (runOpts) => {
      lastOpts = runOpts;
      return Effect.succeed({
        exitCode: opts.exitCode ?? 0,
        stdout: new Uint8Array(0),
        stderr: "",
      });
    },
    runStream: (runOpts, streamOpts) => {
      lastOpts = runOpts;
      return Effect.gen(function* () {
        const encoder = new TextEncoder();
        for (const chunk of opts.stdout ?? []) {
          yield* streamOpts.onStdout(encoder.encode(chunk));
        }
        return { exitCode: opts.exitCode ?? 0, stderr: "" };
      });
    },
  });
  return {
    layer,
    get lastOpts() {
      return lastOpts;
    },
  };
}

const runtimeInfoLayer = Layer.succeed(RuntimeInfo, {
  cwd: "/work/project",
  platform: "linux",
  arch: "x64",
  homeDir: "/home/user",
  execPath: "/usr/bin/supabase",
  pid: 1234,
});

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  exitCode?: number;
  stdout?: ReadonlyArray<string>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const processControl = mockProcessControl();
  const analytics = mockContextualAnalytics();
  const telemetry = mockLegacyTelemetryStateTracked();
  const connection = mockDbConnection();
  const docker = mockDockerRun({ exitCode: opts.exitCode, stdout: opts.stdout });
  const args = ["db", "test"];
  const layer = Layer.mergeAll(
    out.layer,
    processControl.layer,
    analytics.layer,
    telemetry.layer,
    mockResolver(),
    connection.layer,
    docker.layer,
    mockLegacyCliSettings({ workdir: "/work/project", projectId: Option.none() }),
    runtimeInfoLayer,
    Layer.succeed(LegacyDebugFlag, false),
    Layer.succeed(LegacyNetworkIdFlag, Option.none()),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: [] }),
    Stdio.layerTest({ args: Effect.succeed(args) }),
    commandRuntimeLayer(["db", "test"]),
    BunServices.layer,
  );
  return { layer, out, analytics, processControl, connection, docker };
}

const flags = () => ({
  paths: [] as ReadonlyArray<string>,
  dbUrl: Option.none<string>(),
  linked: false,
  local: true,
  projectRef: Option.none<string>(),
});

describe("legacy db test (alias) integration", () => {
  it.live("runs pgTAP through the alias exactly like `test db`", () => {
    const { layer, connection, docker } = setup();
    return Effect.gen(function* () {
      yield* legacyRunTestDbCommand(flags());
      expect(connection.execCalls).toEqual([
        "create extension if not exists pgtap with schema extensions",
        "drop extension if exists pgtap",
      ]);
      // docker.run was reached with the expected pg_prove invocation and
      // returned exit 0 (no failure surfaced above).
      expect(docker.lastOpts?.cmd[0]).toBe("pg_prove");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "dispatches through the real `legacyDbTestCommand` and records `db test`, not `test db`, as the telemetry command",
    () => {
      // `--local --linked` together fail INSIDE `legacyTestDb` (mutual
      // exclusivity) before any DB/docker IO, so this can dispatch through the
      // REAL command tree — proving `test.command.ts`'s own
      // `legacyTestDbRuntimeLayer(["db", "test"])` wiring — without needing a
      // real Postgres or Docker. `withLegacyCommandInstrumentation` still
      // captures `cli_command_executed` on the way out (it wraps the whole
      // handler in `Effect.exit`), so mutating `test.command.ts` to pass
      // `["test", "db"]` instead makes this assertion fail.
      const args = ["db", "test", "--local", "--linked"];
      const analytics = mockContextualAnalytics();
      const layer = Layer.mergeAll(
        BunServices.layer,
        mockRuntimeInfo(),
        mockTty(),
        mockProcessControl().layer,
        mockOutput({ format: "text" }).layer,
        mockTelemetryRuntime(),
        analytics.layer,
        CliOutput.layer(textCliOutputFormatter()),
        Stdio.layerTest({ args: Effect.succeed(args) }),
        Layer.succeed(CliArgs, { args }),
        // `legacyDbCommand` is the whole `db` subtree, so the root's R
        // includes every sibling subcommand's global-flag/Go-delegation
        // requirements too, even though this test only dispatches `db test`.
        Layer.succeed(LegacyAgentFlag, "auto"),
        Layer.succeed(LegacyCreateTicketFlag, false),
        Layer.succeed(LegacyDebugFlag, false),
        Layer.succeed(LegacyDnsResolverFlag, "native"),
        Layer.succeed(LegacyExperimentalFlag, false),
        Layer.succeed(LegacyNetworkIdFlag, Option.none()),
        Layer.succeed(LegacyOutputFlag, Option.none()),
        Layer.succeed(LegacyProfileFlag, "supabase"),
        Layer.succeed(LegacyWorkdirFlag, Option.none()),
        Layer.succeed(LegacyYesFlag, false),
        Layer.succeed(LegacyGoProxy, {
          exec: () => Effect.die("LegacyGoProxy not needed for `db test` dispatch"),
          execCapture: () => Effect.die("LegacyGoProxy not needed for `db test` dispatch"),
        }),
        Layer.succeed(LegacyEdgeRuntimeScript, {
          run: () => Effect.die("LegacyEdgeRuntimeScript not needed for `db test` dispatch"),
        }),
        Layer.succeed(LegacyPgDeltaSslProbe, {
          requireSsl: () => Effect.die("LegacyPgDeltaSslProbe not needed for `db test` dispatch"),
          requireSslForHost: () =>
            Effect.die("LegacyPgDeltaSslProbe not needed for `db test` dispatch"),
        }),
      );
      const root = Command.make("supabase").pipe(
        Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
        Command.withSubcommands([legacyDbCommand]),
      );
      return Effect.gen(function* () {
        yield* Effect.exit(Command.runWith(root, { version: "0.0.0-test" })(args));
        expect(analytics.captured).toHaveLength(1);
        expect(analytics.captured[0]?.event).toBe("cli_command_executed");
        expect(analytics.captured[0]?.properties.command).toBe("db test");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails in text mode when pg_prove exits non-zero", () => {
    const { layer, processControl } = setup({ exitCode: 1 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyRunTestDbCommand(flags()));
      expect(exit._tag).toBe("Failure");
      // Unlike the json-mode branch below (which hand-writes exit 1), text
      // mode must let the failed Effect itself drive the process exit code.
      expect(processControl.exitCode).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "in json mode, a pg_prove failure writes to stderr and sets exit 1 without failing (Go's stdout-safety)",
    () => {
      const { layer, out, processControl } = setup({ format: "json", exitCode: 1 });
      return Effect.gen(function* () {
        // Succeeds (no thrown/failed Effect) so a JSON error envelope is
        // never appended after the TAP stream — established output
        // contract: stderr + exit 1, never corrupting stdout.
        yield* legacyRunTestDbCommand(flags());
        expect(out.stderrText).toContain("error running container: exit 1");
        expect(processControl.exitCode).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails in text mode when the run found no tests", () => {
    const { layer, processControl } = setup({
      exitCode: 0,
      stdout: ["Files=0, Tests=0,  0 wallclock secs\nResult: NOTESTS\n"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyRunTestDbCommand(flags()));
      expect(exit._tag).toBe("Failure");
      // Text mode lets the failed Effect drive the exit code, as for a run failure.
      expect(processControl.exitCode).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("in json mode, a run that found no tests takes the same stderr + exit 1 path", () => {
    const { layer, out, processControl } = setup({
      format: "json",
      exitCode: 0,
      stdout: ["Files=0, Tests=0,  0 wallclock secs\nResult: NOTESTS\n"],
    });
    return Effect.gen(function* () {
      yield* legacyRunTestDbCommand(flags());
      expect(out.stderrText).toContain("no pgTAP tests found in /work/project/supabase/tests");
      expect(processControl.exitCode).toBe(1);
      // The TAP stream reached stdout intact, with no JSON envelope appended.
      expect(out.stdoutText).toBe("Files=0, Tests=0,  0 wallclock secs\nResult: NOTESTS\n");
    }).pipe(Effect.provide(layer));
  });
});
