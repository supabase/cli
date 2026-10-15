/**
 * `db test` is a hidden alias that reuses `test db`'s flag config and handler verbatim (see
 * `test.command.ts`). The core pgTAP behavior is already covered by
 * `../../../shared/test-db.integration.test.ts`, so this file only covers alias-specific
 * behavior: end-to-end delegation, telemetry recording `"db test"` (not `"test db"`) as the
 * invoked path, and the non-text `onRunFailure` branch.
 */
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Stdio } from "effect";
import { CliOutput, Command } from "effect/cli";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import {
  VALID_TOKEN,
  mockCommandSettings,
  mockTelemetryStateTracked,
  sequentialExecBatch,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  asRecordedRequests,
  provideEnv,
  realDbConfigResolver,
  serveLinkedDatabase,
  stubManagementApi,
  type StubbedRequest,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { cliConfigValuesTestLayer } from "../../../../tests/helpers/config-values-layer.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { commandTargetLayer } from "../../../shared/output/command-target.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import {
  GLOBAL_FLAGS,
  AgentFlag,
  CreateTicketFlag,
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
  YesFlag,
} from "../../../command-internal/global-flags.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { CurrentAnalyticsContext } from "../../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import {
  DbConnection,
  type DbSession,
  type PgConnInput,
} from "../../../command-internal/db-connection.service.ts";
import { BundledPostgresClient } from "../../../command-internal/bundled-postgres-client.ts";
import { DockerRun, type DockerRunOpts } from "../../../command-internal/docker-run.service.ts";
import { EdgeRuntimeScript } from "../../../command-internal/edge-runtime-script.service.ts";
import { PgDeltaSslProbe } from "../../../command-internal/pgdelta-ssl-probe.service.ts";
import {
  runTestDbCommand,
  type TestDbFlags,
} from "../../../command-internal/test-db.command-handler.ts";
import { dbCommand } from "../db.command.ts";
import { unusedStackServices } from "../../../../tests/helpers/unused-stack.ts";

const LOCAL_CONN: PgConnInput = {
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
  return Layer.succeed(DbConfigResolver, {
    resolve: () => Effect.succeed({ conn: LOCAL_CONN, isLocal: true }),
    resolveConnection: () => Effect.die("resolveConnection is not used by this test"),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
}

function mockDbConnection() {
  const execCalls: string[] = [];
  const session: DbSession = {
    exec: (sql) =>
      Effect.sync(() => {
        execCalls.push(sql);
      }),
    execBatch: (statements) => sequentialExecBatch(session)(statements),
    extensionExists: () => Effect.succeed(false),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    query: () => Effect.succeed([]),
  };
  const layer = Layer.succeed(DbConnection, {
    connect: () => Effect.succeed(session),
  });
  return { layer, execCalls };
}

function mockDockerRun(opts: { exitCode?: number; stdout?: ReadonlyArray<string> } = {}) {
  let lastOpts: DockerRunOpts | undefined;
  const layer = Layer.succeed(DockerRun, {
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

const REF = "abcdefghijklmnopqrst";

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  exitCode?: number;
  stdout?: ReadonlyArray<string>;
  /** The command-line arguments the handler reads its database target from. */
  args?: ReadonlyArray<string>;
  /** Runs the real `DbConfigResolver` against the temp `workdir`; the test serves its Management API calls. */
  realDbConfig?: boolean;
  workdir?: string;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const processControl = mockProcessControl();
  const analytics = mockContextualAnalytics();
  const telemetry = mockTelemetryStateTracked();
  const connection = mockDbConnection();
  const docker = mockDockerRun({ exitCode: opts.exitCode, stdout: opts.stdout });
  const args = ["db", "test"];
  const workdir = opts.workdir ?? "/work/project";
  const layer = Layer.mergeAll(
    cliConfigValuesTestLayer,
    unusedStackServices,
    out.layer,
    commandTargetLayer.pipe(Layer.provide(out.layer)),
    processControl.layer,
    analytics.layer,
    telemetry.layer,
    opts.realDbConfig === true
      ? realDbConfigResolver({
          workdir,
          dbConnection: connection.layer,
          env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        })
      : mockResolver(),
    connection.layer,
    docker.layer,
    Layer.succeed(BundledPostgresClient, {
      run: () => Effect.die("bundled postgres client unused"),
    }),
    mockCommandSettings({ workdir, projectId: Option.none() }),
    runtimeInfoLayer,
    Layer.succeed(DebugFlag, false),
    Layer.succeed(NetworkIdFlag, Option.none()),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    Stdio.layerTest({ args: Effect.succeed(args) }),
    commandRuntimeLayer(["db", "test"]).pipe(Layer.provide(BunServices.layer)),
    BunServices.layer,
  );
  return { layer, out, analytics, processControl, connection, docker };
}

const flags = (): TestDbFlags => ({
  paths: [],
  dbUrl: Option.none(),
  linked: false,
  local: true,
  projectRef: Option.none(),
});

describe("db test (alias) integration", () => {
  const tempRoot = useTempWorkdir("supabase-db-test-int-");

  it.effect("runs pgTAP through the alias exactly like `test db`", () => {
    const { layer, connection, docker } = setup();
    return Effect.gen(function* () {
      yield* runTestDbCommand(flags());
      expect(connection.execCalls).toEqual([
        "create extension if not exists pgtap with schema extensions",
        "drop extension if exists pgtap",
      ]);
      expect(docker.lastOpts?.cmd[0]).toBe("pg_prove");
    }).pipe(Effect.provide(layer));
  });

  it.effect("mints a login role through the real DB config resolver for --linked", () => {
    const { layer, docker } = setup({
      args: ["db", "test", "--linked", "--project-ref", REF],
      realDbConfig: true,
      workdir: tempRoot.current,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, serveLinkedDatabase(REF));
      yield* runTestDbCommand({
        ...flags(),
        linked: true,
        local: false,
        projectRef: Option.some(REF),
      });
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${REF}/config/database/pooler`,
        `POST /v1/projects/${REF}/cli/login-role`,
      ]);
      expect(docker.lastOpts?.cmd[0]).toBe("pg_prove");
      assertPermissionDrift({
        command: "db test",
        activeFlags: { linked: true, "project-ref": REF },
        requests: asRecordedRequests(requests),
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("defaults to the local target and makes no Management API request", () => {
    const { layer, docker } = setup({ realDbConfig: true, workdir: tempRoot.current });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      yield* runTestDbCommand(flags());
      expect(docker.lastOpts?.cmd[0]).toBe("pg_prove");
      expect(requests).toEqual([]);
      assertPermissionDrift({ command: "db test", requests: [], exact: true });
    }).pipe(
      Effect.scoped,
      Effect.provide(layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("makes no Management API request for --local through the real resolver", () => {
    const { layer, docker } = setup({
      args: ["db", "test", "--local"],
      realDbConfig: true,
      workdir: tempRoot.current,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      yield* runTestDbCommand(flags());
      expect(docker.lastOpts?.cmd[0]).toBe("pg_prove");
      expect(requests).toEqual([]);
      assertPermissionDrift({
        command: "db test",
        activeFlags: { local: true },
        requests: [],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect(
    "dispatches through the real `dbTestCommand` and records `db test`, not `test db`, as the telemetry command",
    () => {
      // `--local --linked` fail inside `testDb` (mutual exclusivity) before any DB/docker IO,
      // so this can dispatch through the real command tree without a real Postgres or Docker.
      const args = ["db", "test", "--local", "--linked"];
      const analytics = mockContextualAnalytics();
      const out = mockOutput({ format: "text" });
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        unusedStackServices,
        BunServices.layer,
        mockRuntimeInfo(),
        mockTty(),
        mockProcessControl().layer,
        out.layer,
        commandTargetLayer.pipe(Layer.provide(out.layer)),
        mockTelemetryRuntime(),
        analytics.layer,
        CliOutput.layer(textCliOutputFormatter()),
        Stdio.layerTest({ args: Effect.succeed(args) }),
        Layer.succeed(CliArgs, { args }),
        // `dbCommand` is the whole `db` subtree, so its R includes every sibling subcommand's
        // global-flag requirements too, even though this test only dispatches `db test`.
        Layer.succeed(AgentFlag, "auto"),
        Layer.succeed(CreateTicketFlag, false),
        Layer.succeed(DebugFlag, false),
        Layer.succeed(DnsResolverFlag, "native"),
        Layer.succeed(ExperimentalFlag, false),
        Layer.succeed(NetworkIdFlag, Option.none()),
        Layer.succeed(OutputFlag, Option.none()),
        Layer.succeed(ProfileFlag, "supabase"),
        Layer.succeed(WorkdirFlag, Option.none()),
        Layer.succeed(YesFlag, false),
        Layer.succeed(EdgeRuntimeScript, {
          run: () => Effect.die("EdgeRuntimeScript not needed for `db test` dispatch"),
        }),
        Layer.succeed(PgDeltaSslProbe, {
          requireSsl: () => Effect.die("PgDeltaSslProbe not needed for `db test` dispatch"),
          requireSslForHost: () => Effect.die("PgDeltaSslProbe not needed for `db test` dispatch"),
        }),
      );
      const root = Command.make("supabase").pipe(
        Command.withGlobalFlags(GLOBAL_FLAGS),
        Command.withSubcommands([dbCommand]),
      );
      return Effect.gen(function* () {
        yield* Effect.exit(Command.runWith(root, { version: "0.0.0-test" })(args));
        expect(analytics.captured).toHaveLength(1);
        expect(analytics.captured[0]?.event).toBe("cli_command_executed");
        expect(analytics.captured[0]?.properties.command).toBe("db test");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("fails in text mode when pg_prove exits non-zero", () => {
    const { layer, processControl } = setup({ exitCode: 1 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runTestDbCommand(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      // Text mode lets the failed Effect itself drive the process exit code, unlike the
      // json-mode branch below, which hand-writes exit 1.
      expect(processControl.exitCode).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "in json mode, a pg_prove failure writes to stderr and sets exit 1 without failing",
    () => {
      const { layer, out, processControl } = setup({ format: "json", exitCode: 1 });
      return Effect.gen(function* () {
        // Succeeds (no thrown/failed Effect), so a JSON error envelope is never appended
        // after the TAP stream.
        yield* runTestDbCommand(flags());
        expect(out.stderrText).toContain("error running container: exit 1");
        expect(processControl.exitCode).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("fails in text mode when the run found no tests", () => {
    const { layer, processControl } = setup({
      exitCode: 0,
      stdout: ["Files=0, Tests=0,  0 wallclock secs\nResult: NOTESTS\n"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runTestDbCommand(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      // Text mode lets the failed Effect drive the exit code, as for a run failure.
      expect(processControl.exitCode).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("in json mode, a run that found no tests takes the same stderr + exit 1 path", () => {
    const { layer, out, processControl } = setup({
      format: "json",
      exitCode: 0,
      stdout: ["Files=0, Tests=0,  0 wallclock secs\nResult: NOTESTS\n"],
    });
    return Effect.gen(function* () {
      yield* runTestDbCommand(flags());
      expect(out.stderrText).toContain("no pgTAP tests found in /work/project/supabase/tests");
      expect(processControl.exitCode).toBe(1);
      // The TAP stream reached stdout intact, with no JSON envelope appended.
      expect(out.stdoutText).toBe("Files=0, Tests=0,  0 wallclock secs\nResult: NOTESTS\n");
    }).pipe(Effect.provide(layer));
  });
});
