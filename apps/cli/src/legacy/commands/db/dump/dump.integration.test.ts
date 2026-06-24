import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import {
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type { LegacyDbConfigFlags } from "../../../shared/legacy-db-config.types.ts";
import type { LegacyPgConnInput } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDbConfigConnectTempRoleError } from "../../../shared/legacy-db-config.errors.ts";
import { LegacyDockerRunError } from "../../../shared/legacy-docker-run.errors.ts";
import {
  LegacyDockerRun,
  type LegacyDockerRunOpts,
} from "../../../shared/legacy-docker-run.service.ts";
import type { LegacyDbDumpFlags } from "./dump.command.ts";
import { legacyDbDump } from "./dump.handler.ts";

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

function mockResolver(opts: {
  conn?: LegacyPgConnInput;
  isLocal?: boolean;
  poolerFallback?: Option.Option<LegacyPgConnInput>;
  poolerFallbackFails?: boolean;
  resolveFails?: boolean;
  ref?: string;
}) {
  const calls: LegacyDbConfigFlags[] = [];
  const fallbackCalls: LegacyDbConfigFlags[] = [];
  const layer = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (flags) => {
      calls.push(flags);
      // Simulate Go's NewDbConfigWithPassword failing during connection resolution
      // (IPv6 probe / pooler / temp login-role) after the ref is already loaded.
      if (opts.resolveFails === true) {
        return Effect.fail(
          new LegacyDbConfigConnectTempRoleError({ message: "failed to create temp role" }),
        );
      }
      return Effect.succeed({
        conn: opts.conn ?? LOCAL_CONN,
        isLocal: opts.isLocal ?? true,
        ref: opts.ref === undefined ? undefined : Option.some(opts.ref),
      });
    },
    resolvePoolerFallback: (flags) => {
      fallbackCalls.push(flags);
      return opts.poolerFallbackFails === true
        ? Effect.fail(
            new LegacyDbConfigConnectTempRoleError({ message: "failed to create temp role" }),
          )
        : Effect.succeed(opts.poolerFallback ?? Option.none());
    },
  });
  return {
    layer,
    get calls() {
      return calls;
    },
    get fallbackCalls() {
      return fallbackCalls;
    },
  };
}

interface DockerResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

function mockDockerRun(opts: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  runFails?: boolean;
  // A queue of results, one per runCapture call (for the pooler-fallback retry).
  // Falls back to the single exitCode/stdout/stderr result when exhausted.
  results?: ReadonlyArray<DockerResult>;
}) {
  const allOpts: LegacyDockerRunOpts[] = [];
  const queue = [...(opts.results ?? [])];
  const layer = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.succeed(0),
    runCapture: (runOpts) => {
      allOpts.push(runOpts);
      if (opts.runFails === true) {
        return Effect.fail(
          new LegacyDockerRunError({ message: "failed to run docker: not found" }),
        );
      }
      const next = queue.shift();
      const r = next ?? { exitCode: opts.exitCode, stdout: opts.stdout, stderr: opts.stderr };
      return Effect.succeed({
        exitCode: r.exitCode ?? 0,
        stdout: new TextEncoder().encode(r.stdout ?? ""),
        stderr: r.stderr ?? "",
      });
    },
    // db dump now streams stdout: deliver the configured bytes to `onStdout` (as Go's
    // StdCopy would), then report the exit code + stderr.
    runStream: (runOpts, streamOpts) =>
      Effect.gen(function* () {
        allOpts.push(runOpts);
        if (opts.runFails === true) {
          return yield* Effect.fail(
            new LegacyDockerRunError({ message: "failed to run docker: not found" }),
          );
        }
        const next = queue.shift();
        const r = next ?? { exitCode: opts.exitCode, stdout: opts.stdout, stderr: opts.stderr };
        const bytes = new TextEncoder().encode(r.stdout ?? "");
        if (bytes.length > 0) yield* streamOpts.onStdout(bytes);
        return { exitCode: r.exitCode ?? 0, stderr: r.stderr ?? "" };
      }),
  });
  return {
    layer,
    get allOpts() {
      return allOpts;
    },
    get lastOpts() {
      return allOpts[allOpts.length - 1];
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
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  runFails?: boolean;
  results?: ReadonlyArray<DockerResult>;
  poolerFallback?: Option.Option<LegacyPgConnInput>;
  poolerFallbackFails?: boolean;
  networkId?: string;
  workdir?: string;
  projectId?: Option.Option<string>;
  resolveFails?: boolean;
  ref?: string;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const resolver = mockResolver({
    conn: opts.conn,
    isLocal: opts.isLocal,
    poolerFallback: opts.poolerFallback,
    poolerFallbackFails: opts.poolerFallbackFails,
    resolveFails: opts.resolveFails,
    ref: opts.ref,
  });
  const docker = mockDockerRun(opts);
  const layer = Layer.mergeAll(
    out.layer,
    resolver.layer,
    docker.layer,
    mockLegacyCliConfig({
      workdir: opts.workdir ?? "/work/project",
      projectId: opts.projectId ?? Option.none(),
    }),
    telemetry.layer,
    cache.layer,
    runtimeInfoLayer,
    Layer.succeed(
      LegacyNetworkIdFlag,
      opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
    ),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    BunServices.layer,
  );
  return { layer, out, telemetry, resolver, docker, cache };
}

const flags = (over: Partial<LegacyDbDumpFlags> = {}): LegacyDbDumpFlags => ({
  dryRun: over.dryRun ?? false,
  dataOnly: over.dataOnly ?? Option.none(),
  useCopy: over.useCopy ?? false,
  exclude: over.exclude ?? [],
  roleOnly: over.roleOnly ?? Option.none(),
  keepComments: over.keepComments ?? Option.none(),
  file: over.file ?? Option.none(),
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? Option.none(),
  local: over.local ?? Option.none(),
  password: over.password ?? Option.none(),
  schema: over.schema ?? [],
});

const failMessage = (exit: Exit.Exit<unknown, { readonly message: string }>): string | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error.message : undefined;

const failSuggestion = (
  exit: Exit.Exit<unknown, { readonly message: string; readonly suggestion?: string }>,
): string | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error.suggestion : undefined;

describe("legacy db dump integration", () => {
  const tmp = useLegacyTempWorkdir();

  it.live("errors when --use-copy is used without --data-only", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags({ useCopy: true, local: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(`required flag(s) "data-only" not set`);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "allows --use-copy with an explicit --data-only=false (Go required check is presence)",
    () => {
      // cobra's required-flag check keys off flag.Changed, so `--data-only=false`
      // satisfies it; Go proceeds and runs the schema dump with dataOnly=false.
      const { layer } = setup({ isLocal: true, stdout: "SELECT 1;\n" });
      return Effect.gen(function* () {
        const exit = yield* legacyDbDump(
          flags({ useCopy: true, dataOnly: Option.some(false), local: Option.some(true) }),
        ).pipe(Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("errors when --exclude is used without --data-only", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(
        flags({ exclude: ["public.users"], local: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(`required flag(s) "data-only" not set`);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects combining --data-only and --role-only", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(
        flags({ dataOnly: Option.some(true), roleOnly: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [role-only data-only] are set none of the others can be; [data-only role-only] were all set",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects combining --keep-comments and --data-only", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(
        flags({ keepComments: Option.some(true), dataOnly: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [keep-comments data-only] are set none of the others can be; [data-only keep-comments] were all set",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects combining --schema and --role-only", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(
        flags({ schema: ["public"], roleOnly: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [schema role-only] are set none of the others can be; [role-only schema] were all set",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects combining --linked and --local", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(
        flags({ linked: Option.some(true), local: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --linked=false --local as a target conflict (Go flag.Changed)", () => {
    // cobra keys the target mutex off flag.Changed, so the explicit-false `--linked`
    // still counts as set and conflicts with `--local`.
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(
        flags({ linked: Option.some(false), local: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --data-only=false --role-only as a conflict (Go flag.Changed)", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(
        flags({ dataOnly: Option.some(false), roleOnly: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [role-only data-only] are set none of the others can be; [data-only role-only] were all set",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --local=false as an explicit local target (Go ParseDatabaseConfig)", () => {
    // Go selects local on Changed("local") before the linked default, so `--local=false`
    // resolves the local target, not the linked one.
    const { layer, resolver } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ local: Option.some(false), dryRun: true }));
      expect(resolver.calls[0]?.connType).toBe("local");
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the expanded pg_dump script on --dry-run without running a container", () => {
    const { layer, out, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ dryRun: true, local: Option.some(true) }));
      expect(out.stderrText).toContain("DRY RUN: *only* printing the pg_dump script to console.");
      expect(out.stderrText).toContain("Dumping schemas from local database...");
      // The script must have $PGHOST expanded from the resolved local connection.
      expect(out.stdoutText).toContain('export PGHOST="127.0.0.1"');
      expect(docker.lastOpts).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the post-run Dumped-schema message on --dry-run --file without writing", () => {
    // Go's dump.Run skips opening the file on dry-run but returns success, so cobra's
    // PostRun still prints `Dumped schema to <abs>.` (cmd/db.go:148-156), with no
    // dry-run guard and without touching the file (dump.go:23-32).
    const filePath = join(tmp.current, "dry.sql");
    const { layer, out, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(
        flags({ dryRun: true, local: Option.some(true), file: Option.some(filePath) }),
      );
      expect(out.stderrText).toContain("DRY RUN: *only* printing the pg_dump script to console.");
      expect(out.stderrText).toContain(`Dumped schema to`);
      expect(out.stderrText).toContain(filePath);
      // No container ran and the file was never created/truncated on dry-run.
      expect(docker.lastOpts).toBeUndefined();
      expect(existsSync(filePath)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("validates the merged config before the --dry-run print (Go root PreRun order)", () => {
    // Go runs ParseDatabaseConfig (→ config.Load → Validate) in the root PreRunE
    // before dump.Run, even for --dry-run, so an invalid config fails without printing.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      ["[remotes.staging]", 'project_id = "staging"', ""].join("\n"),
    );
    const { layer, out } = setup({ isLocal: true, workdir: tmp.current });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags({ dryRun: true, local: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toContain(
        "Invalid config for remotes.staging.project_id. Must be like: abcdefghijklmnopqrst",
      );
      expect(out.stdoutText).toBe(""); // no script printed
    }).pipe(Effect.provide(layer));
  });

  it.live("dumps schema from the local database to stdout", () => {
    const { layer, out, docker } = setup({ isLocal: true, stdout: "CREATE SCHEMA public;\n" });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ local: Option.some(true) }));
      expect(out.stderrText).toContain("Dumping schemas from local database...");
      expect(out.stdoutText).toBe("CREATE SCHEMA public;\n");
      expect(docker.lastOpts?.cmd).toEqual([
        "bash",
        "-c",
        expect.stringContaining("pg_dump"),
        "--",
      ]);
      // host networking, no security-opt
      expect(docker.lastOpts?.network).toEqual({ _tag: "host" });
      expect(docker.lastOpts?.securityOpt).toEqual([]);
      expect(docker.lastOpts?.env["EXCLUDED_SCHEMAS"]).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("dumps only data with column inserts", () => {
    const { layer, out, docker } = setup({ isLocal: true, stdout: "INSERT INTO ...;\n" });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ dataOnly: Option.some(true), local: Option.some(true) }));
      expect(out.stderrText).toContain("Dumping data from local database...");
      expect(docker.lastOpts?.env["EXTRA_FLAGS"]).toBe("--column-inserts --rows-per-insert 100000");
    }).pipe(Effect.provide(layer));
  });

  it.live("dumps only data without column inserts when --use-copy is set", () => {
    const { layer, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(
        flags({ dataOnly: Option.some(true), useCopy: true, local: Option.some(true) }),
      );
      expect(docker.lastOpts?.env["EXTRA_FLAGS"]).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("dumps only roles", () => {
    const { layer, out, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ roleOnly: Option.some(true), local: Option.some(true) }));
      expect(out.stderrText).toContain("Dumping roles from local database...");
      expect(docker.lastOpts?.env["RESERVED_ROLES"]).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("limits the dump to selected schemas", () => {
    const { layer, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ schema: ["public", "auth"], local: Option.some(true) }));
      expect(docker.lastOpts?.env["EXTRA_FLAGS"]).toBe("--schema=public|auth");
    }).pipe(Effect.provide(layer));
  });

  it.live("joins a multi-schema selection into EXTRA_FLAGS with pipes", () => {
    // CSV-splitting of `--schema` now happens at the flag level via
    // `legacyParseSchemaFlags` (Go's cobra StringSlice / `cmd/db.go:444`), so the
    // handler receives the already-split array and the env builder pipe-joins it.
    const { layer, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ schema: ["public", "auth"], local: Option.some(true) }));
      expect(docker.lastOpts?.env["EXTRA_FLAGS"]).toBe("--schema=public|auth");
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves a relative --file against the workdir", () => {
    // Go chdir's into the workdir before opening --file, so a relative path is
    // written under the workdir, not the original cwd.
    const { layer } = setup({
      isLocal: true,
      stdout: "CREATE SCHEMA public;\n",
      workdir: tmp.current,
    });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ local: Option.some(true), file: Option.some("out.sql") }));
      expect(readFileSync(join(tmp.current, "out.sql"), "utf8")).toBe("CREATE SCHEMA public;\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("honors --network-id over host networking", () => {
    const { layer, docker } = setup({ isLocal: true, networkId: "custom_net" });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ local: Option.some(true) }));
      expect(docker.lastOpts?.network).toEqual({ _tag: "named", name: "custom_net" });
    }).pipe(Effect.provide(layer));
  });

  it.live("defaults to the linked connection when neither --local nor --db-url is set", () => {
    const { layer, resolver } = setup({ conn: REMOTE_CONN, isLocal: false });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({}));
      expect(resolver.calls[0]).toMatchObject({ connType: "linked" });
    }).pipe(Effect.provide(layer));
  });

  it.live("caches the linked project even when connection resolution fails (Go PostRun)", () => {
    // Go's LoadProjectRef sets flags.ProjectRef BEFORE NewDbConfigWithPassword
    // (flags/db_url.go:88 vs :95), and ensureProjectGroupsCached runs on failure too
    // (cmd/root.go:176). So an IPv6/pooler/login-role failure during resolution still
    // refreshes the linked-project cache, because the ref was already loaded — here
    // from config.toml project_id.
    const { layer, cache, resolver } = setup({
      projectId: Option.some("abcdefghijklmnopqrst"),
      resolveFails: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags({ linked: Option.some(true) })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(resolver.calls[0]).toMatchObject({ connType: "linked" });
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("does not cache when the linked ref is unknown and resolution fails", () => {
    // No config project_id and no .temp/project-ref file (workdir is a throwaway
    // path), so the ref is never loaded; Go gates ensureProjectGroupsCached on
    // flags.ProjectRef != "", so nothing is cached.
    const { layer, cache } = setup({ resolveFails: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags({ linked: Option.some(true) })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("caches the linked project from the resolved ref on a successful dump", () => {
    const { layer, cache } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      ref: "abcdefghijklmnopqrst",
      stdout: "CREATE SCHEMA public;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ linked: Option.some(true) }));
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes the dump to --file and reports the absolute path on stderr", () => {
    const filePath = join(tmp.current, "out.sql");
    const { layer, out } = setup({ isLocal: true, stdout: "CREATE SCHEMA public;\n" });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ local: Option.some(true), file: Option.some(filePath) }));
      expect(readFileSync(filePath, "utf8")).toBe("CREATE SCHEMA public;\n");
      expect(out.stderrText).toContain(`Dumped schema to`);
      expect(out.stderrText).toContain(filePath);
      // Nothing written to stdout in --file mode.
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with exit 1 when the container exits non-zero", () => {
    const { layer } = setup({ isLocal: true, exitCode: 1, stdout: "partial\n" });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags({ local: Option.some(true) })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe("error running container: exit 1");
    }).pipe(Effect.provide(layer));
  });

  const POOLER_CONN: LegacyPgConnInput = {
    host: "aws-0-us-east-1.pooler.supabase.com",
    port: 5432,
    user: "postgres.abcdefghijklmnopqrst",
    password: "temp",
    database: "postgres",
  };
  const IPV6_STDERR =
    'could not translate host name "db.abcdefghijklmnopqrst.supabase.co" to address: No address associated with hostname';

  it.live("linked: retries through the IPv4 pooler on a container IPv6 failure", () => {
    const { layer, out, resolver, docker } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      poolerFallback: Option.some(POOLER_CONN),
      results: [
        { exitCode: 1, stderr: IPV6_STDERR },
        { exitCode: 0, stdout: "CREATE SCHEMA x;\n" },
      ],
    });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags());
      // Retried once: two container runs, one fallback resolution.
      expect(docker.allOpts).toHaveLength(2);
      expect(resolver.fallbackCalls).toHaveLength(1);
      expect(resolver.fallbackCalls[0]).toMatchObject({ connType: "linked" });
      // The retry targeted the pooler host (PGHOST in the rebuilt env).
      expect(docker.allOpts[1]?.env["PGHOST"]).toBe(POOLER_CONN.host);
      // The IPv6 warning was printed to stderr; only the retry's output reached stdout.
      expect(out.stderrText).toContain("does not support IPv6");
      expect(out.stderrText).toContain("Retrying via the IPv4 connection pooler.");
      expect(out.stdoutText).toBe("CREATE SCHEMA x;\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("linked: preserves the original dump error when the pooler fallback fails", () => {
    // Go's PoolerFallbackConfig returns ok=false on any fallback-resolution error and
    // reports the original pg_dump failure — the optional retry must not replace it.
    const { layer, resolver, docker } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      poolerFallbackFails: true,
      results: [{ exitCode: 1, stderr: IPV6_STDERR }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      // Original container failure, NOT the fallback-resolution error.
      expect(failMessage(exit)).toBe("error running container: exit 1");
      expect(resolver.fallbackCalls).toHaveLength(1); // attempted
      expect(docker.allOpts).toHaveLength(1); // no retry container ran
    }).pipe(Effect.provide(layer));
  });

  it.live("linked: does not retry when the failure is not an IPv6 connectivity error", () => {
    const { layer, resolver, docker } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      poolerFallback: Option.some(POOLER_CONN),
      results: [{ exitCode: 1, stderr: "permission denied for schema public" }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe("error running container: exit 1");
      expect(docker.allOpts).toHaveLength(1);
      expect(resolver.fallbackCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("linked: keeps the original error when no pooler fallback is available", () => {
    const { layer, resolver, docker } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      poolerFallback: Option.none(),
      results: [{ exitCode: 1, stderr: IPV6_STDERR }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe("error running container: exit 1");
      // The fallback was attempted (classified IPv6) but returned no pooler.
      expect(resolver.fallbackCalls).toHaveLength(1);
      expect(docker.allOpts).toHaveLength(1);
      // Go's SetConnectSuggestion attaches the IPv6 pooler guidance on the no-fallback
      // path (pooler_fallback.go:60-64); the bare container error must carry it.
      expect(failSuggestion(exit)).toContain(
        "Your network does not support IPv6, which is required for direct connections",
      );
      expect(failSuggestion(exit)).toContain("IPv4 transaction pooler");
    }).pipe(Effect.provide(layer));
  });

  it.live("linked: attaches the IPv6 suggestion when the pooler retry also fails", () => {
    // Go's RunWithPoolerFallback calls SetConnectSuggestion on the retry's stderr when
    // the pooler retry also fails (pooler_fallback.go:52-55); an IPv6 retry failure
    // surfaces the same guidance.
    const { layer, docker } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      poolerFallback: Option.some(POOLER_CONN),
      results: [
        { exitCode: 1, stderr: IPV6_STDERR },
        { exitCode: 1, stderr: IPV6_STDERR },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe("error running container: exit 1");
      expect(docker.allOpts).toHaveLength(2); // original + failed retry
      expect(failSuggestion(exit)).toContain("Your network does not support IPv6");
    }).pipe(Effect.provide(layer));
  });

  it.live("linked: no IPv6 suggestion on a non-IPv6 container failure", () => {
    const { layer } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      poolerFallback: Option.some(POOLER_CONN),
      results: [{ exitCode: 1, stderr: "permission denied for schema public" }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failSuggestion(exit)).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("json mode: emits the SQL to stdout with no machine envelope", () => {
    const { layer, out } = setup({ format: "json", isLocal: true, stdout: "CREATE SCHEMA x;\n" });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ local: Option.some(true) }));
      expect(out.stdoutText).toBe("CREATE SCHEMA x;\n");
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("stream-json mode: emits the SQL to stdout with no machine envelope", () => {
    const { layer, out } = setup({
      format: "stream-json",
      isLocal: true,
      stdout: "CREATE SCHEMA x;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ local: Option.some(true) }));
      expect(out.stdoutText).toBe("CREATE SCHEMA x;\n");
    }).pipe(Effect.provide(layer));
  });
});
