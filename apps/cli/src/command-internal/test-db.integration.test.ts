import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { mockOutput } from "../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { DebugFlag, DnsResolverFlag, NetworkIdFlag } from "./global-flags.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { DbConfigResolver } from "./db-config.service.ts";
import { DbConnectError, DbExecError } from "./db-connection.errors.ts";
import { DbConnection, type DbSession, type PgConnInput } from "./db-connection.service.ts";
import { DockerRunError } from "./docker-run.errors.ts";
import { DockerRun, type DockerRunOpts } from "./docker-run.service.ts";
import { testDb } from "./test-db.handler.ts";

const LOCAL_CONN: PgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};
const REMOTE_CONN: PgConnInput = {
  host: "db.abcdefghijklmnopqrst.supabase.co",
  port: 5432,
  user: "postgres",
  password: "secret",
  database: "postgres",
};

function mockResolver(opts: { conn?: PgConnInput; isLocal?: boolean } = {}) {
  const calls: Array<{
    readonly connType: string;
    readonly linkedProjectRef: Option.Option<string>;
  }> = [];
  const layer = Layer.succeed(DbConfigResolver, {
    resolve: (flags) => {
      calls.push({
        connType: flags.connType ?? "",
        linkedProjectRef: flags.linkedProjectRef ?? Option.none(),
      });
      return Effect.succeed({ conn: opts.conn ?? LOCAL_CONN, isLocal: opts.isLocal ?? true });
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
  return {
    layer,
    get calls() {
      return calls;
    },
  };
}

function mockDbConnection(opts: {
  existed?: boolean;
  connectFails?: boolean;
  enableFails?: boolean;
  dropFails?: boolean;
}) {
  const execCalls: string[] = [];
  const session: DbSession = {
    exec: (sql) =>
      Effect.gen(function* () {
        execCalls.push(sql);
        if (opts.enableFails === true && sql.includes("create extension")) {
          return yield* Effect.fail(new DbExecError({ message: "permission denied" }));
        }
        if (opts.dropFails === true && sql.includes("drop extension")) {
          return yield* Effect.fail(new DbExecError({ message: "cannot drop" }));
        }
      }),
    // `test db` never runs a migration batch; keep the seam explicit rather than silent.
    execBatch: () => Effect.die("execBatch unused"),
    extensionExists: () => Effect.succeed(opts.existed ?? false),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    query: () => Effect.succeed([]),
  };
  const connectCalls: Array<{
    cfg: PgConnInput;
    isLocal: boolean;
    dnsResolver: "native" | "https";
  }> = [];
  const layer = Layer.succeed(DbConnection, {
    connect: (cfg, options) => {
      connectCalls.push({ cfg, isLocal: options.isLocal, dnsResolver: options.dnsResolver });
      return opts.connectFails === true
        ? Effect.fail(new DbConnectError({ message: "failed to connect to postgres: refused" }))
        : Effect.succeed(session);
    },
  });
  return {
    layer,
    get execCalls() {
      return execCalls;
    },
    get connectCalls() {
      return connectCalls;
    },
  };
}

function mockDockerRun(opts: {
  exitCode?: number;
  runFails?: boolean;
  /** pg_prove's stdout, delivered to `onStdout` one array entry per chunk. */
  stdout?: ReadonlyArray<string>;
}) {
  let lastOpts: DockerRunOpts | undefined;
  let lastStreamOpts:
    | { readonly teeStderr?: boolean; readonly captureStderr?: boolean }
    | undefined;
  const layer = Layer.succeed(DockerRun, {
    run: (runOpts) => {
      lastOpts = runOpts;
      return opts.runFails === true
        ? Effect.fail(
            new DockerRunError({
              message: "failed to run docker: not found",
              reason: "spawn",
              daemonDown: false,
            }),
          )
        : Effect.succeed(opts.exitCode ?? 0);
    },
    runCapture: (runOpts) => {
      lastOpts = runOpts;
      return opts.runFails === true
        ? Effect.fail(
            new DockerRunError({
              message: "failed to run docker: not found",
              reason: "spawn",
              daemonDown: false,
            }),
          )
        : Effect.succeed({ exitCode: opts.exitCode ?? 0, stdout: new Uint8Array(0), stderr: "" });
    },
    runStream: (runOpts, streamOpts) => {
      lastOpts = runOpts;
      lastStreamOpts = streamOpts;
      return opts.runFails === true
        ? Effect.fail(
            new DockerRunError({
              message: "failed to run docker: not found",
              reason: "spawn",
              daemonDown: false,
            }),
          )
        : Effect.gen(function* () {
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
    get lastStreamOpts() {
      return lastStreamOpts;
    },
  };
}

const runtimeInfoLayer = (platform: NodeJS.Platform) =>
  Layer.succeed(RuntimeInfo, {
    cwd: "/work/project",
    platform,
    arch: "x64",
    homeDir: "/home/user",
    execPath: "/usr/bin/supabase",
    pid: 1234,
  });

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  platform?: NodeJS.Platform;
  conn?: PgConnInput;
  isLocal?: boolean;
  existed?: boolean;
  connectFails?: boolean;
  enableFails?: boolean;
  dropFails?: boolean;
  exitCode?: number;
  runFails?: boolean;
  stdout?: ReadonlyArray<string>;
  debug?: boolean;
  networkId?: string;
  workdir?: string;
  dnsResolver?: "native" | "https";
  /** Raw CLI args for `CliArgs` — drives DB target selection (Changed-based). */
  args?: ReadonlyArray<string>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockTelemetryStateTracked();
  const resolver = mockResolver({ conn: opts.conn, isLocal: opts.isLocal });
  const connection = mockDbConnection(opts);
  const docker = mockDockerRun(opts);
  const layer = Layer.mergeAll(
    out.layer,
    resolver.layer,
    connection.layer,
    docker.layer,
    mockCommandSettings({ workdir: opts.workdir ?? "/work/project", projectId: Option.none() }),
    telemetry.layer,
    runtimeInfoLayer(opts.platform ?? "linux"),
    Layer.succeed(DebugFlag, opts.debug ?? false),
    Layer.succeed(
      NetworkIdFlag,
      opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
    ),
    Layer.succeed(DnsResolverFlag, opts.dnsResolver ?? "native"),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    BunServices.layer,
  );
  return { layer, out, telemetry, connection, docker, resolver };
}

const flags = (over: Partial<Parameters<typeof testDb>[0]> = {}) => ({
  paths: over.paths ?? [],
  dbUrl: over.dbUrl ?? Option.none<string>(),
  linked: over.linked ?? false,
  local: over.local ?? true,
  projectRef: over.projectRef ?? Option.none<string>(),
});

describe("test db integration", () => {
  it.live("runs pgTAP on the local db: enables then drops pgtap, exits 0", () => {
    const { layer, connection, docker } = setup();
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(connection.execCalls).toEqual([
        "create extension if not exists pgtap with schema extensions",
        "drop extension if exists pgtap",
      ]);
      const run = docker.lastOpts;
      expect(run?.network).toEqual({ _tag: "named", name: "supabase_network_project" });
      expect(run?.env["PGHOST"]).toBe("db");
      expect(run?.env["PGPORT"]).toBe("5432");
      expect(run?.securityOpt).toEqual(["label:disable"]);
      expect(run?.cmd.slice(0, 5)).toEqual(["pg_prove", "--ext", ".pg", "--ext", ".sql"]);
      expect(connection.connectCalls[0]?.isLocal).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("adds the host.docker.internal host-gateway mapping on Linux", () => {
    // The default RuntimeInfo mock reports platform "linux".
    const { layer, docker } = setup();
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(docker.lastOpts?.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("omits the host-gateway mapping on macOS/Windows", () => {
    const { layer, docker } = setup({ platform: "darwin" });
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(docker.lastOpts?.extraHosts).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("omits --security-opt inside Bitbucket Pipelines (BITBUCKET_CLONE_DIR set)", () => {
    const { layer, docker } = setup();
    const prev = process.env["BITBUCKET_CLONE_DIR"];
    process.env["BITBUCKET_CLONE_DIR"] = "/opt/atlassian/pipelines/agent/build";
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(docker.lastOpts?.securityOpt).toEqual([]);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["BITBUCKET_CLONE_DIR"];
          else process.env["BITBUCKET_CLONE_DIR"] = prev;
        }),
      ),
    );
  });

  it.live("skips dropping pgtap when it already existed", () => {
    const { layer, connection } = setup({ existed: true });
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(connection.execCalls).toEqual([
        "create extension if not exists pgtap with schema extensions",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("logs to stderr but still succeeds when dropping pgtap fails", () => {
    const { layer, out } = setup({ dropFails: true });
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(out.stderrText).toContain("failed to disable pgTAP: cannot drop");
    }).pipe(Effect.provide(layer));
  });

  it.live("defaults to supabase/tests and mounts it read-only when no paths given", () => {
    const { layer, docker } = setup();
    return Effect.gen(function* () {
      yield* testDb(flags());
      const run = docker.lastOpts;
      expect(run?.binds).toEqual(["/work/project/supabase/tests:/work/project/supabase/tests:ro"]);
      expect(Option.getOrNull(run?.workingDir ?? Option.none())).toBe(
        "/work/project/supabase/tests",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("mounts a single file's containing directory so `\\ir` includes resolve", () => {
    const { layer, docker } = setup();
    return Effect.gen(function* () {
      yield* testDb(flags({ paths: ["/abs/a_test.sql"] }));
      const run = docker.lastOpts;
      expect(run?.binds).toEqual(["/abs:/abs:ro"]);
      expect(run?.cmd).toContain("/abs/a_test.sql");
    }).pipe(Effect.provide(layer));
  });

  it.live("appends --verbose when --debug is set", () => {
    const { layer, docker } = setup({ debug: true });
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(docker.lastOpts?.cmd).toContain("--verbose");
    }).pipe(Effect.provide(layer));
  });

  it.live("db-url mode: uses host networking and the resolved host/port", () => {
    const { layer, docker, connection } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      args: ["--db-url=postgres://x"],
    });
    return Effect.gen(function* () {
      yield* testDb(flags({ dbUrl: Option.some("postgres://x") }));
      const run = docker.lastOpts;
      expect(run?.network).toEqual({ _tag: "host" });
      expect(run?.env["PGHOST"]).toBe(REMOTE_CONN.host);
      expect(run?.env["PGPORT"]).toBe("5432");
      expect(connection.connectCalls[0]?.isLocal).toBe(false);
      expect(connection.connectCalls[0]?.dnsResolver).toBe("native");
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards --dns-resolver https to the driver for the connection", () => {
    const { layer, connection } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      dnsResolver: "https",
      args: ["--db-url=postgres://x"],
    });
    return Effect.gen(function* () {
      yield* testDb(flags({ dbUrl: Option.some("postgres://x") }));
      expect(connection.connectCalls[0]?.dnsResolver).toBe("https");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with TestDbEnablePgtapError when enabling pgTAP fails", () => {
    const { layer } = setup({ enableFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to enable pgTAP: permission denied");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with DbConnectError when the connection fails", () => {
    const { layer } = setup({ connectFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to connect to postgres");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with exit-N error when pg_prove exits non-zero", () => {
    const { layer } = setup({ exitCode: 3 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("error running container: exit 3");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when pg_prove ran no tests, even though it exited 0 (CLI-2194)", () => {
    const { layer } = setup({
      exitCode: 0,
      stdout: ["Files=0, Tests=0,  0 wallclock secs\nResult: NOTESTS\n"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags({ paths: ["tests/db"] })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "no pgTAP tests found in /work/project/tests/db",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("detects the NOTESTS verdict when it straddles a stdout chunk boundary", () => {
    const { layer } = setup({ exitCode: 0, stdout: ["Files=0, Tests=0\nResult: NOTE", "STS\n"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("detects the NOTESTS verdict arriving one byte per chunk", () => {
    const { layer } = setup({
      exitCode: 0,
      stdout: [..."Files=0, Tests=0\nResult: NOTESTS\n"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("detects the NOTESTS verdict when the stream ends without a trailing newline", () => {
    const { layer } = setup({ exitCode: 0, stdout: ["Files=0, Tests=0\nResult: NOTESTS"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("passes a suite that deliberately skips itself, which also ends NOTESTS", () => {
    // `1..0 # SKIP …` reports `Files=1, Tests=0` + `Result: NOTESTS` and exits 0 —
    // a file was found, so this is a successful run, not an empty one.
    const { layer } = setup({
      exitCode: 0,
      stdout: [
        "skip.test.sql .. skipped: not applicable on this platform\n",
        "Files=1, Tests=0,  0 wallclock secs\nResult: NOTESTS\n",
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags()));
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("does not trip on the verdict text mid-line, as a --verbose replay can emit", () => {
    const { layer } = setup({
      exitCode: 0,
      stdout: ["# diag: Result: NOTESTS is what an empty run prints\n", "Result: PASS\n"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags()));
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("takes the harness's final verdict, not a passing test's own Result: line", () => {
    // A passing test's own `--debug` TAP replay may legally print a line
    // starting `Result: NOTESTS…`; only the harness's last verdict decides.
    const { layer } = setup({
      exitCode: 0,
      stdout: [
        "ok 1 - passes\n",
        "Result: NOTESTS is diagnostic text\n",
        "ok 2 - passes\n",
        "Files=1, Tests=2,  0 wallclock secs\nResult: PASS\n",
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags()));
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("tees container stderr without retaining it, as inheriting stdio did", () => {
    // A pgTAP suite's psql notices are unbounded; buffering them for a string
    // nothing reads would grow with the whole run.
    const { layer, docker } = setup();
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(docker.lastStreamOpts?.teeStderr).toBe(true);
      expect(docker.lastStreamOpts?.captureStderr).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards the TAP stream to stdout byte-exact and succeeds on a passing run", () => {
    const chunks = ["a.test.sql .. ok\n", "All tests successful.\n", "Result: PASS\n"];
    const { layer, out } = setup({ exitCode: 0, stdout: chunks });
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(out.stdoutText).toBe(chunks.join(""));
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when docker itself cannot run", () => {
    const { layer } = setup({ runFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to run docker");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("json mode: streams TAP only — emits no result envelope (Go parity)", () => {
    const { layer, out } = setup({ format: "json", exitCode: 0 });
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("stream-json mode: emits no result envelope (Go parity)", () => {
    const { layer, out } = setup({ format: "stream-json", exitCode: 0 });
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects mutually exclusive connection flags (--linked + --local via args)", () => {
    const { layer } = setup({ args: ["--linked", "--local"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("--local=false --linked fails with mutual-exclusion (sorted set [linked local])", () => {
    const { layer } = setup({ args: ["--local=false", "--linked"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("--linked=false routes to the linked branch (Changed, not value)", () => {
    const { layer } = setup({ args: ["--linked=false"] });
    return Effect.gen(function* () {
      // No explicit assertion: success means routing reached resolver.resolve
      // with connType "linked" instead of failing on mutual exclusion or the
      // local-target guard.
      yield* testDb(flags());
    }).pipe(Effect.provide(layer));
  });

  it.live("tests the project given via --project-ref --linked", () => {
    // Only reaches the resolver as `linkedProjectRef` when --linked is set.
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, resolver } = setup({ conn: REMOTE_CONN, isLocal: false, args: ["--linked"] });
    return Effect.gen(function* () {
      yield* testDb(flags({ linked: true, local: false, projectRef: Option.some(FLAG_REF) }));
      expect(resolver.calls[0]?.connType).toBe("linked");
      expect(resolver.calls[0]?.linkedProjectRef).toEqual(Option.some(FLAG_REF));
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --project-ref on the default local target", () => {
    // No explicit --local/--db-url flag; the guard must fire from the default alone.
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, connection, docker, resolver } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testDb(flags({ projectRef: Option.some(FLAG_REF) })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        );
      }
      expect(resolver.calls).toEqual([]);
      expect(connection.execCalls).toEqual([]);
      expect(docker.lastOpts).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("honors --network-id, overriding the generated local network name", () => {
    const { layer, docker } = setup({ networkId: "my-custom-net" });
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(docker.lastOpts?.network).toEqual({ _tag: "named", name: "my-custom-net" });
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry via ensuring", () => {
    const { layer, telemetry } = setup();
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes the connection diagnostic to stderr, keeping stdout for TAP (Go parity)", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(out.stderrText).toContain("Connecting to local database...");
      expect(out.stdoutText).toBe("");
      expect(out.messages).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("labels the connection diagnostic 'remote' for non-local connections", () => {
    const { layer, out } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      args: ["--db-url=postgres://x"],
    });
    return Effect.gen(function* () {
      yield* testDb(flags({ dbUrl: Option.some("postgres://x") }));
      expect(out.stderrText).toContain("Connecting to remote database...");
    }).pipe(Effect.provide(layer));
  });

  const tempWorkdir = useTempWorkdir();
  it.live("sanitizes a configured project_id when naming the local network (Go parity)", () => {
    const workdir = tempWorkdir.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), 'project_id = "My Project"\n');
    const { layer, docker } = setup({ workdir });
    return Effect.gen(function* () {
      yield* testDb(flags());
      expect(docker.lastOpts?.network).toEqual({
        _tag: "named",
        name: "supabase_network_My_Project",
      });
    }).pipe(Effect.provide(layer));
  });
});
