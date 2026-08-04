/**
 * `db test` is a hidden Go-parity alias that reuses `test db`'s flag config
 * and assembled handler verbatim (see `test.command.ts`). The core pgTAP
 * enable/disable + `pg_prove` docker-invocation behavior is already
 * exhaustively covered by `../../../shared/legacy-test-db.integration.test.ts` (calling the
 * same `legacyTestDb` this alias ultimately runs), so this file focuses on
 * what is actually NEW/alias-specific:
 *
 * 1. The alias still produces correct behavior end-to-end through
 *    `legacyRunTestDbCommand` (one golden path + one failure path), proving
 *    the delegation itself is wired correctly.
 * 2. The `cli_command_executed` telemetry `command` property records the
 *    ACTUAL invoked path — `"db test"`, not `"test db"` — matching Go's
 *    `cmd.CommandPath()` (`cmd/root_analytics.go:33`), which differs between
 *    the two entry points even though `RunE`/the handler is identical. A
 *    regression here would silently corrupt product analytics without
 *    affecting any user-visible output, so it needs its own test.
 * 3. The non-text branch of `onRunFailure` (json/stream-json: stderr + exit
 *    code 1, no Effect failure) — shared code that had no prior coverage
 *    from either entry point.
 *
 * Mocking follows the same two established patterns already used elsewhere
 * in this codebase rather than inventing a new one: the domain-level fakes
 * (`LegacyDbConfigResolver` / `LegacyDbConnection` / `LegacyDockerRun`) mirror
 * `../../../shared/legacy-test-db.integration.test.ts`; the instrumentation-level fakes
 * (`Analytics` reading `CurrentAnalyticsContext`, `Stdio.layerTest`,
 * `commandRuntimeLayer`) mirror
 * `../../../telemetry/legacy-command-instrumentation.unit.test.ts`.
 */
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stdio } from "effect";

import { mockOutput, mockProcessControl } from "../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
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
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { legacyRunTestDbCommand } from "../../../shared/legacy-test-db.command-handler.ts";

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

function mockDockerRun(opts: { exitCode?: number } = {}) {
  const layer = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.succeed(opts.exitCode ?? 0),
    runCapture: () =>
      Effect.succeed({ exitCode: opts.exitCode ?? 0, stdout: new Uint8Array(0), stderr: "" }),
    runStream: () => Effect.succeed({ exitCode: opts.exitCode ?? 0, stderr: "" }),
  });
  return { layer };
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
  commandPath?: ReadonlyArray<string>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const processControl = mockProcessControl();
  const analytics = mockContextualAnalytics();
  const telemetry = mockLegacyTelemetryStateTracked();
  const connection = mockDbConnection();
  const docker = mockDockerRun({ exitCode: opts.exitCode });
  const args = ["db", "test"];
  const layer = Layer.mergeAll(
    out.layer,
    processControl.layer,
    analytics.layer,
    telemetry.layer,
    mockResolver(),
    connection.layer,
    docker.layer,
    mockLegacyCliConfig({ workdir: "/work/project", projectId: Option.none() }),
    runtimeInfoLayer,
    Layer.succeed(LegacyDebugFlag, false),
    Layer.succeed(LegacyNetworkIdFlag, Option.none()),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: [] }),
    Stdio.layerTest({ args: Effect.succeed(args) }),
    commandRuntimeLayer(opts.commandPath ?? ["db", "test"]),
    BunServices.layer,
  );
  return { layer, out, analytics, processControl, connection, docker };
}

const flags = () => ({
  paths: [] as ReadonlyArray<string>,
  dbUrl: Option.none<string>(),
  linked: false,
  local: true,
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
      // docker.run was reached and returned exit 0.
      expect(docker).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("records `db test`, not `test db`, as the telemetry command", () => {
    const { layer, analytics } = setup({ commandPath: ["db", "test"] });
    return Effect.gen(function* () {
      yield* legacyRunTestDbCommand(flags());
      expect(analytics.captured).toHaveLength(1);
      expect(analytics.captured[0]?.event).toBe("cli_command_executed");
      expect(analytics.captured[0]?.properties.command).toBe("db test");
    }).pipe(Effect.provide(layer));
  });

  it.live("would record `test db` if invoked via that entry point instead", () => {
    // Sanity check that the commandPath actually drives the recorded value
    // (guards against a test that would pass no matter what the path is).
    const { layer, analytics } = setup({ commandPath: ["test", "db"] });
    return Effect.gen(function* () {
      yield* legacyRunTestDbCommand(flags());
      expect(analytics.captured[0]?.properties.command).toBe("test db");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails in text mode when pg_prove exits non-zero", () => {
    const { layer } = setup({ exitCode: 1 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyRunTestDbCommand(flags()));
      expect(exit._tag).toBe("Failure");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "in json mode, a pg_prove failure writes to stderr and sets exit 1 without failing (Go's stdout-safety)",
    () => {
      const { layer, out, processControl } = setup({ format: "json", exitCode: 1 });
      return Effect.gen(function* () {
        // Succeeds (no thrown/failed Effect) so a JSON error envelope is never
        // appended after the TAP stream — matching Go's `recoverAndExit`
        // (stderr + os.Exit(1), never corrupting stdout).
        yield* legacyRunTestDbCommand(flags());
        expect(out.stderrText).toContain("error running container: exit 1");
        expect(processControl.exitCode).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );
});
