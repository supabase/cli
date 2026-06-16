import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
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

function mockResolver(opts: { conn?: LegacyPgConnInput; isLocal?: boolean }) {
  const calls: LegacyDbConfigFlags[] = [];
  const layer = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (flags) => {
      calls.push(flags);
      return Effect.succeed({ conn: opts.conn ?? LOCAL_CONN, isLocal: opts.isLocal ?? true });
    },
  });
  return {
    layer,
    get calls() {
      return calls;
    },
  };
}

function mockDockerRun(opts: { exitCode?: number; stdout?: string; runFails?: boolean }) {
  let lastOpts: LegacyDockerRunOpts | undefined;
  const layer = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.succeed(0),
    runCapture: (runOpts) => {
      lastOpts = runOpts;
      return opts.runFails === true
        ? Effect.fail(new LegacyDockerRunError({ message: "failed to run docker: not found" }))
        : Effect.succeed({
            exitCode: opts.exitCode ?? 0,
            stdout: new TextEncoder().encode(opts.stdout ?? ""),
            stderr: "",
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
  conn?: LegacyPgConnInput;
  isLocal?: boolean;
  exitCode?: number;
  stdout?: string;
  runFails?: boolean;
  networkId?: string;
  workdir?: string;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const resolver = mockResolver({ conn: opts.conn, isLocal: opts.isLocal });
  const docker = mockDockerRun(opts);
  const layer = Layer.mergeAll(
    out.layer,
    resolver.layer,
    docker.layer,
    mockLegacyCliConfig({ workdir: opts.workdir ?? "/work/project", projectId: Option.none() }),
    telemetry.layer,
    runtimeInfoLayer,
    Layer.succeed(
      LegacyNetworkIdFlag,
      opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
    ),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    BunServices.layer,
  );
  return { layer, out, telemetry, resolver, docker };
}

const flags = (over: Partial<LegacyDbDumpFlags> = {}): LegacyDbDumpFlags => ({
  dryRun: over.dryRun ?? false,
  dataOnly: over.dataOnly ?? false,
  useCopy: over.useCopy ?? false,
  exclude: over.exclude ?? [],
  roleOnly: over.roleOnly ?? false,
  keepComments: over.keepComments ?? false,
  file: over.file ?? Option.none(),
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  password: over.password ?? Option.none(),
  schema: over.schema ?? [],
});

const failMessage = (exit: Exit.Exit<unknown, { readonly message: string }>): string | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error.message : undefined;

describe("legacy db dump integration", () => {
  const tmp = useLegacyTempWorkdir();

  it.live("errors when --use-copy is used without --data-only", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags({ useCopy: true, local: true })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(`required flag(s) "data-only" not set`);
    }).pipe(Effect.provide(layer));
  });

  it.live("errors when --exclude is used without --data-only", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags({ exclude: ["public.users"], local: true })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(`required flag(s) "data-only" not set`);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects combining --data-only and --role-only", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags({ dataOnly: true, roleOnly: true })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [role-only data-only] are set none of the others can be; [data-only role-only] were all set",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects combining --keep-comments and --data-only", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags({ keepComments: true, dataOnly: true })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [keep-comments data-only] are set none of the others can be; [data-only keep-comments] were all set",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects combining --schema and --role-only", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags({ schema: ["public"], roleOnly: true })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [schema role-only] are set none of the others can be; [role-only schema] were all set",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects combining --linked and --local", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(flags({ linked: true, local: true })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the expanded pg_dump script on --dry-run without running a container", () => {
    const { layer, out, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ dryRun: true, local: true }));
      expect(out.stderrText).toContain("DRY RUN: *only* printing the pg_dump script to console.");
      expect(out.stderrText).toContain("Dumping schemas from local database...");
      // The script must have $PGHOST expanded from the resolved local connection.
      expect(out.stdoutText).toContain('export PGHOST="127.0.0.1"');
      expect(docker.lastOpts).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("dumps schema from the local database to stdout", () => {
    const { layer, out, docker } = setup({ isLocal: true, stdout: "CREATE SCHEMA public;\n" });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ local: true }));
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
      yield* legacyDbDump(flags({ dataOnly: true, local: true }));
      expect(out.stderrText).toContain("Dumping data from local database...");
      expect(docker.lastOpts?.env["EXTRA_FLAGS"]).toBe("--column-inserts --rows-per-insert 100000");
    }).pipe(Effect.provide(layer));
  });

  it.live("dumps only data without column inserts when --use-copy is set", () => {
    const { layer, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ dataOnly: true, useCopy: true, local: true }));
      expect(docker.lastOpts?.env["EXTRA_FLAGS"]).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("dumps only roles", () => {
    const { layer, out, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ roleOnly: true, local: true }));
      expect(out.stderrText).toContain("Dumping roles from local database...");
      expect(docker.lastOpts?.env["RESERVED_ROLES"]).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("limits the dump to selected schemas", () => {
    const { layer, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ schema: ["public", "auth"], local: true }));
      expect(docker.lastOpts?.env["EXTRA_FLAGS"]).toBe("--schema=public|auth");
    }).pipe(Effect.provide(layer));
  });

  it.live("splits comma-separated --schema values like cobra StringSlice", () => {
    // Go declares --schema as a cobra StringSlice, which comma-splits each value.
    const { layer, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ schema: ["public,auth"], local: true }));
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
      yield* legacyDbDump(flags({ local: true, file: Option.some("out.sql") }));
      expect(readFileSync(join(tmp.current, "out.sql"), "utf8")).toBe("CREATE SCHEMA public;\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("honors --network-id over host networking", () => {
    const { layer, docker } = setup({ isLocal: true, networkId: "custom_net" });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ local: true }));
      expect(docker.lastOpts?.network).toEqual({ _tag: "named", name: "custom_net" });
    }).pipe(Effect.provide(layer));
  });

  it.live("defaults to the linked connection when neither --local nor --db-url is set", () => {
    const { layer, resolver } = setup({ conn: REMOTE_CONN, isLocal: false });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({}));
      expect(resolver.calls[0]).toMatchObject({ linked: true, local: false });
    }).pipe(Effect.provide(layer));
  });

  it.live("writes the dump to --file and reports the absolute path on stderr", () => {
    const filePath = join(tmp.current, "out.sql");
    const { layer, out } = setup({ isLocal: true, stdout: "CREATE SCHEMA public;\n" });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ local: true, file: Option.some(filePath) }));
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
      const exit = yield* legacyDbDump(flags({ local: true })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe("error running container: exit 1");
    }).pipe(Effect.provide(layer));
  });

  it.live("json mode: emits the SQL to stdout with no machine envelope", () => {
    const { layer, out } = setup({ format: "json", isLocal: true, stdout: "CREATE SCHEMA x;\n" });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ local: true }));
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
      yield* legacyDbDump(flags({ local: true }));
      expect(out.stdoutText).toBe("CREATE SCHEMA x;\n");
    }).pipe(Effect.provide(layer));
  });
});
