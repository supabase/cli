import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  LegacyDbConnectError,
  LegacyDbExecError,
} from "../../../shared/legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRunError } from "../../../shared/legacy-docker-run.errors.ts";
import {
  LegacyDockerRun,
  type LegacyDockerRunOpts,
} from "../../../shared/legacy-docker-run.service.ts";
import { legacyTestDb } from "./db.handler.ts";

const LOCAL_CONN: LegacyPgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};
const REMOTE_CONN: LegacyPgConnInput = {
  host: "db.abcdefghijklmnopqrst.supabase.co",
  port: 5432,
  user: "postgres",
  password: "secret",
  database: "postgres",
};

function mockResolver(opts: { conn?: LegacyPgConnInput; isLocal?: boolean } = {}) {
  return Layer.succeed(LegacyDbConfigResolver, {
    resolve: () => Effect.succeed({ conn: opts.conn ?? LOCAL_CONN, isLocal: opts.isLocal ?? true }),
  });
}

function mockDbConnection(opts: {
  existed?: boolean;
  connectFails?: boolean;
  enableFails?: boolean;
  dropFails?: boolean;
}) {
  const execCalls: string[] = [];
  const session: LegacyDbSession = {
    exec: (sql) =>
      Effect.gen(function* () {
        execCalls.push(sql);
        if (opts.enableFails === true && sql.includes("create extension")) {
          return yield* Effect.fail(new LegacyDbExecError({ message: "permission denied" }));
        }
        if (opts.dropFails === true && sql.includes("drop extension")) {
          return yield* Effect.fail(new LegacyDbExecError({ message: "cannot drop" }));
        }
      }),
    extensionExists: () => Effect.succeed(opts.existed ?? false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    query: () => Effect.succeed([]),
  };
  const connectCalls: Array<{
    cfg: LegacyPgConnInput;
    isLocal: boolean;
    dnsResolver: "native" | "https";
  }> = [];
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: (cfg, options) => {
      connectCalls.push({ cfg, isLocal: options.isLocal, dnsResolver: options.dnsResolver });
      return opts.connectFails === true
        ? Effect.fail(
            new LegacyDbConnectError({ message: "failed to connect to postgres: refused" }),
          )
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

function mockDockerRun(opts: { exitCode?: number; runFails?: boolean }) {
  let lastOpts: LegacyDockerRunOpts | undefined;
  const layer = Layer.succeed(LegacyDockerRun, {
    run: (runOpts) => {
      lastOpts = runOpts;
      return opts.runFails === true
        ? Effect.fail(new LegacyDockerRunError({ message: "failed to run docker: not found" }))
        : Effect.succeed(opts.exitCode ?? 0);
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
  conn?: LegacyPgConnInput;
  isLocal?: boolean;
  existed?: boolean;
  connectFails?: boolean;
  enableFails?: boolean;
  dropFails?: boolean;
  exitCode?: number;
  runFails?: boolean;
  debug?: boolean;
  networkId?: string;
  workdir?: string;
  dnsResolver?: "native" | "https";
  /** Raw CLI args for `CliArgs` — drives DB target selection (Changed-based). */
  args?: ReadonlyArray<string>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const resolver = mockResolver({ conn: opts.conn, isLocal: opts.isLocal });
  const connection = mockDbConnection(opts);
  const docker = mockDockerRun(opts);
  const layer = Layer.mergeAll(
    out.layer,
    resolver,
    connection.layer,
    docker.layer,
    mockLegacyCliConfig({ workdir: opts.workdir ?? "/work/project", projectId: Option.none() }),
    telemetry.layer,
    runtimeInfoLayer,
    Layer.succeed(LegacyDebugFlag, opts.debug ?? false),
    Layer.succeed(
      LegacyNetworkIdFlag,
      opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
    ),
    Layer.succeed(LegacyDnsResolverFlag, opts.dnsResolver ?? "native"),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    BunServices.layer,
  );
  return { layer, out, telemetry, connection, docker };
}

const flags = (over: Partial<Parameters<typeof legacyTestDb>[0]> = {}) => ({
  paths: over.paths ?? [],
  dbUrl: over.dbUrl ?? Option.none<string>(),
  linked: over.linked ?? false,
  local: over.local ?? true,
});

describe("legacy test db integration", () => {
  it.live("runs pgTAP on the local db: enables then drops pgtap, exits 0", () => {
    const { layer, connection, docker } = setup();
    return Effect.gen(function* () {
      yield* legacyTestDb(flags());
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
      // The setup connection must be told it is local so the driver disables TLS
      // (Go's `ConnectLocalPostgres` sets `cc.TLSConfig = nil`).
      expect(connection.connectCalls[0]?.isLocal).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("adds the host.docker.internal host-gateway mapping on Linux", () => {
    // Go populates HostConfig.ExtraHosts with this on Linux (docker_linux.go); the
    // test RuntimeInfo mock reports platform "linux".
    const { layer, docker } = setup();
    return Effect.gen(function* () {
      yield* legacyTestDb(flags());
      expect(docker.lastOpts?.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("omits --security-opt inside Bitbucket Pipelines (BITBUCKET_CLONE_DIR set)", () => {
    // Go clears hostConfig.SecurityOpt when BITBUCKET_CLONE_DIR is set, because
    // Bitbucket rejects --security-opt (apps/cli-go/internal/utils/docker.go:288-293).
    const { layer, docker } = setup();
    const prev = process.env["BITBUCKET_CLONE_DIR"];
    process.env["BITBUCKET_CLONE_DIR"] = "/opt/atlassian/pipelines/agent/build";
    return Effect.gen(function* () {
      yield* legacyTestDb(flags());
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
      yield* legacyTestDb(flags());
      expect(connection.execCalls).toEqual([
        "create extension if not exists pgtap with schema extensions",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("logs to stderr but still succeeds when dropping pgtap fails", () => {
    const { layer, out } = setup({ dropFails: true });
    return Effect.gen(function* () {
      yield* legacyTestDb(flags());
      expect(out.stderrText).toContain("failed to disable pgTAP: cannot drop");
    }).pipe(Effect.provide(layer));
  });

  it.live("defaults to supabase/tests and mounts it read-only when no paths given", () => {
    const { layer, docker } = setup();
    return Effect.gen(function* () {
      yield* legacyTestDb(flags());
      const run = docker.lastOpts;
      expect(run?.binds).toEqual(["/work/project/supabase/tests:/work/project/supabase/tests:ro"]);
      expect(Option.getOrNull(run?.workingDir ?? Option.none())).toBe(
        "/work/project/supabase/tests",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("passes explicit paths as read-only binds", () => {
    const { layer, docker } = setup();
    return Effect.gen(function* () {
      yield* legacyTestDb(flags({ paths: ["/abs/a_test.sql"] }));
      const run = docker.lastOpts;
      expect(run?.binds).toEqual(["/abs/a_test.sql:/abs/a_test.sql:ro"]);
      expect(run?.cmd).toContain("/abs/a_test.sql");
    }).pipe(Effect.provide(layer));
  });

  it.live("appends --verbose when --debug is set", () => {
    const { layer, docker } = setup({ debug: true });
    return Effect.gen(function* () {
      yield* legacyTestDb(flags());
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
      yield* legacyTestDb(flags({ dbUrl: Option.some("postgres://x") }));
      const run = docker.lastOpts;
      expect(run?.network).toEqual({ _tag: "host" });
      expect(run?.env["PGHOST"]).toBe(REMOTE_CONN.host);
      expect(run?.env["PGPORT"]).toBe("5432");
      // Remote connection → driver must enable TLS (Go strips non-TLS fallbacks
      // in `ConnectByUrl`); the handler signals this via `isLocal: false`.
      expect(connection.connectCalls[0]?.isLocal).toBe(false);
      // Default DNS resolver flows through to the driver unchanged.
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
      yield* legacyTestDb(flags({ dbUrl: Option.some("postgres://x") }));
      // Go installs the DoH fallback resolver for remote connects when
      // `--dns-resolver https` is set (`connect.go:211-213`); the handler must
      // hand the same value to the driver rather than silently using OS DNS.
      expect(connection.connectCalls[0]?.dnsResolver).toBe("https");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyTestDbEnablePgtapError when enabling pgTAP fails", () => {
    const { layer } = setup({ enableFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyTestDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to enable pgTAP: permission denied");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyDbConnectError when the connection fails", () => {
    const { layer } = setup({ connectFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyTestDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to connect to postgres");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with exit-N error when pg_prove exits non-zero", () => {
    const { layer } = setup({ exitCode: 3 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyTestDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("error running container: exit 3");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when docker itself cannot run", () => {
    const { layer } = setup({ runFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyTestDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to run docker");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("json mode: streams TAP only — emits no result envelope (Go parity)", () => {
    const { layer, out } = setup({ format: "json", exitCode: 0 });
    return Effect.gen(function* () {
      yield* legacyTestDb(flags());
      // Go has no machine output for `test db`; the TS port must not append a
      // JSON object that would corrupt the pg_prove TAP stream on stdout.
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("stream-json mode: emits no result envelope (Go parity)", () => {
    const { layer, out } = setup({ format: "stream-json", exitCode: 0 });
    return Effect.gen(function* () {
      yield* legacyTestDb(flags());
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects mutually exclusive connection flags (--linked + --local via args)", () => {
    const { layer } = setup({ args: ["--linked", "--local"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyTestDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("--local=false --linked fails with mutual-exclusion (sorted set [linked local])", () => {
    // Both flags Changed → mutual exclusion fires with cobra's sorted alphabetical set.
    const { layer } = setup({ args: ["--local=false", "--linked"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyTestDb(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("--linked=false routes to the linked branch (Changed, not value)", () => {
    // cobra's Changed fires when the flag appears regardless of value:
    // `--linked=false` is still "explicitly set" → linked branch.
    // The resolver mock will be called with connType="linked".
    const { layer } = setup({ args: ["--linked=false"] });
    return Effect.gen(function* () {
      // The resolver mock doesn't validate — success means routing reached resolver.resolve
      // with connType "linked" (no mutual-exclusion error, no local fallback error).
      yield* legacyTestDb(flags());
    }).pipe(Effect.provide(layer));
  });

  it.live("honors --network-id, overriding the generated local network name", () => {
    const { layer, docker } = setup({ networkId: "my-custom-net" });
    return Effect.gen(function* () {
      yield* legacyTestDb(flags());
      expect(docker.lastOpts?.network).toEqual({ _tag: "named", name: "my-custom-net" });
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry via ensuring", () => {
    const { layer, telemetry } = setup();
    return Effect.gen(function* () {
      yield* legacyTestDb(flags());
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes the connection diagnostic to stderr, keeping stdout for TAP (Go parity)", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyTestDb(flags());
      // Go writes "Connecting to local database..." to os.Stderr and reserves
      // stdout for the pg_prove TAP stream. A spinner/task on stdout would corrupt
      // that stream (and stream-json task events would too), so the port must emit
      // this on stderr and produce no stdout bytes of its own.
      expect(out.stderrText).toContain("Connecting to local database...");
      expect(out.stdoutText).toBe("");
      // Go has no "Running pgTAP tests..." line and no spinner task messages.
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
      yield* legacyTestDb(flags({ dbUrl: Option.some("postgres://x") }));
      expect(out.stderrText).toContain("Connecting to remote database...");
    }).pipe(Effect.provide(layer));
  });

  const tempWorkdir = useLegacyTempWorkdir();
  it.live("sanitizes a configured project_id when naming the local network (Go parity)", () => {
    const workdir = tempWorkdir.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    // Go auto-fixes an invalid project_id via sanitizeProjectId (config.go:471,
    // 803-805); the local stack network is created from the sanitized id, so
    // `test db --local` must join `supabase_network_My_Project`, not the raw value.
    writeFileSync(join(workdir, "supabase", "config.toml"), 'project_id = "My Project"\n');
    const { layer, docker } = setup({ workdir });
    return Effect.gen(function* () {
      yield* legacyTestDb(flags());
      expect(docker.lastOpts?.network).toEqual({
        _tag: "named",
        name: "supabase_network_My_Project",
      });
    }).pipe(Effect.provide(layer));
  });
});
