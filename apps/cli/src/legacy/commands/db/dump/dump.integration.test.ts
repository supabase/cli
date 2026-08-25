import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  mockLegacyCliSettings,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import {
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import {
  LegacyInvalidProjectRefError,
  LegacyProjectNotLinkedError,
} from "../../../config/legacy-project-ref.errors.ts";
import {
  INVALID_PROJECT_REF_MESSAGE,
  LegacyProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
  PROJECT_REF_PATTERN,
} from "../../../config/legacy-project-ref.service.ts";
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
      // Simulate connection resolution failing (IPv6 probe / pooler / temp
      // login-role) after the ref is already loaded.
      if (opts.resolveFails === true) {
        return Effect.fail(
          new LegacyDbConfigConnectTempRoleError({ message: "failed to create temp role" }),
        );
      }
      // A threaded `--project-ref` flag wins over the fixed `opts.ref` test
      // fixture, same top precedence a real resolver would give it — lets a
      // test prove the flag (not just `opts.ref`) drives the resolved (and
      // later cached) ref.
      const linkedProjectRef = flags.linkedProjectRef ?? Option.none();
      const ref =
        Option.isSome(linkedProjectRef) && linkedProjectRef.value.length > 0
          ? linkedProjectRef.value
          : opts.ref;
      return Effect.succeed({
        conn: opts.conn ?? LOCAL_CONN,
        isLocal: opts.isLocal ?? true,
        ref: ref === undefined ? undefined : Option.some(ref),
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

/**
 * Mocks `LegacyProjectRefResolver` for the up-front `loadProjectRef` pre-capture
 * (`dump.handler.ts`), mirroring push/diff's identical mock (`push.integration.test.ts`,
 * `diff.integration.test.ts`): `loadProjectRef` gives an explicit `--project-ref` flag
 * top precedence, same as Go's `flags.LoadProjectRef` — a real (non-empty) ref pattern
 * is validated so a malformed flag surfaces `LegacyInvalidProjectRefError`, matching the
 * real service. `opts.projectId` stands in for `LegacyCliSettings.projectId`
 * (`SUPABASE_PROJECT_ID`/`project_id`), which `loadProjectRef` consults before falling
 * back to `opts.ref` (the SAME ref `mockResolver`'s own mock embeds in its resolved
 * `ref`, so both stay consistent regardless of which fixture a test sets).
 * `opts.linkedFails` simulates a genuinely unlinked workdir absent an explicit flag.
 */
function mockProjectRefResolver(opts: {
  projectId: Option.Option<string>;
  ref?: string;
  linkedFails?: boolean;
}) {
  const validate = (ref: string) =>
    PROJECT_REF_PATTERN.test(ref)
      ? Effect.succeed(ref)
      : Effect.fail(
          new LegacyInvalidProjectRefError({ ref, message: INVALID_PROJECT_REF_MESSAGE }),
        );
  const layer = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(opts.ref ?? LEGACY_VALID_REF),
    resolveForLink: () => Effect.succeed(opts.ref ?? LEGACY_VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(opts.ref ?? LEGACY_VALID_REF)),
    loadProjectRef: (flagValue: Option.Option<string>) => {
      if (Option.isSome(flagValue) && flagValue.value.length > 0) {
        return validate(flagValue.value);
      }
      if (Option.isSome(opts.projectId)) {
        return validate(opts.projectId.value);
      }
      return opts.linkedFails === true
        ? Effect.fail(new LegacyProjectNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }))
        : Effect.succeed(opts.ref ?? LEGACY_VALID_REF);
    },
    promptProjectRef: () => Effect.succeed(opts.ref ?? LEGACY_VALID_REF),
  });
  return { layer };
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
          new LegacyDockerRunError({
            message: "failed to run docker: not found",
            reason: "spawn",
            daemonDown: false,
          }),
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
    // db dump now streams stdout: deliver the configured bytes to `onStdout`,
    // then report the exit code + stderr.
    runStream: (runOpts, streamOpts) =>
      Effect.gen(function* () {
        allOpts.push(runOpts);
        if (opts.runFails === true) {
          return yield* Effect.fail(
            new LegacyDockerRunError({
              message: "failed to run docker: not found",
              reason: "spawn",
              daemonDown: false,
            }),
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
  linkedFails?: boolean;
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
  const projectRef = mockProjectRefResolver({
    projectId: opts.projectId ?? Option.none(),
    ref: opts.ref,
    linkedFails: opts.linkedFails,
  });
  const docker = mockDockerRun(opts);
  const layer = Layer.mergeAll(
    out.layer,
    resolver.layer,
    projectRef.layer,
    docker.layer,
    mockLegacyCliSettings({
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
  projectRef: over.projectRef ?? Option.none(),
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
      // The required-flag check keys off explicit presence, so `--data-only=false`
      // satisfies it; the command proceeds and runs the schema dump with dataOnly=false.
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
    // The target mutex keys off explicit presence, so the explicit-false
    // `--linked` still counts as set and conflicts with `--local`.
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
    // Local is selected on explicit presence of `--local` before the linked
    // default, so `--local=false` resolves the local target, not the linked one.
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
    // The file is never opened on dry-run, but `Dumped schema to <abs>.` is
    // still printed, with no dry-run guard and without touching the file.
    const filePath = join(tmp.current, "dry.sql");
    const { layer, out, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(
        flags({ dryRun: true, local: Option.some(true), file: Option.some(filePath) }),
      );
      expect(out.stderrText).toContain("DRY RUN: *only* printing the pg_dump script to console.");
      expect(out.stderrText).toContain(`Dumped schema to`);
      expect(out.stderrText).toContain(filePath);
      expect(docker.lastOpts).toBeUndefined();
      expect(existsSync(filePath)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("treats an explicit --file '' as stdout on --dry-run (Go: len(path) > 0)", () => {
    // Every --file branch keys off len(path) > 0, not flag presence; an
    // explicit empty --file means stdout, with no "Dumped schema to …" line
    // and no file ever touched.
    const { layer, out, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ dryRun: true, local: Option.some(true), file: Option.some("") }));
      expect(out.stderrText).toContain("DRY RUN: *only* printing the pg_dump script to console.");
      expect(out.stderrText).not.toContain("Dumped schema to");
      expect(docker.lastOpts).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("validates the merged config before the --dry-run print (Go root PreRun order)", () => {
    // The merged config is validated before the dump runs, even for
    // --dry-run, so an invalid config fails without printing.
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
    // CSV-splitting of `--schema` happens at the flag level via
    // `legacyParseSchemaFlags`, so the handler receives the already-split
    // array and the env builder pipe-joins it.
    const { layer, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ schema: ["public", "auth"], local: Option.some(true) }));
      expect(docker.lastOpts?.env["EXTRA_FLAGS"]).toBe("--schema=public|auth");
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves a relative --file against the workdir", () => {
    // A relative `--file` is resolved against the workdir, so it is written
    // under the workdir, not the original cwd.
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

  it.live(
    "resolves the pg_dump network via SUPABASE_NETWORK_ID from supabase/.env when neither the flag nor the ambient env is set",
    () => {
      // Host networking is the default, but a resolved `--network-id`/`SUPABASE_NETWORK_ID`
      // value overrides it whenever non-empty — a value sourced only from `supabase/.env`
      // still wins over host.
      const prev = process.env["SUPABASE_NETWORK_ID"];
      delete process.env["SUPABASE_NETWORK_ID"];
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_NETWORK_ID=dotenv-net\n");
      const { layer, docker } = setup({ isLocal: true, workdir: tmp.current });
      return Effect.gen(function* () {
        yield* legacyDbDump(flags({ local: Option.some(true) }));
        expect(docker.lastOpts?.network).toEqual({ _tag: "named", name: "dotenv-net" });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (prev === undefined) delete process.env["SUPABASE_NETWORK_ID"];
            else process.env["SUPABASE_NETWORK_ID"] = prev;
          }),
        ),
        Effect.provide(layer),
      );
    },
  );

  it.live("defaults to the linked connection when neither --local nor --db-url is set", () => {
    const { layer, resolver } = setup({ conn: REMOTE_CONN, isLocal: false });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({}));
      expect(resolver.calls[0]).toMatchObject({ connType: "linked" });
    }).pipe(Effect.provide(layer));
  });

  it.live("caches the linked project even when connection resolution fails (Go PostRun)", () => {
    // The project ref is resolved before the connection is built, and the
    // linked-project cache is refreshed unconditionally afterward. So an
    // IPv6/pooler/login-role failure during resolution still refreshes the
    // linked-project cache, because the ref was already loaded — here from
    // config.toml project_id.
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

  it.live(
    "caches the flag ref, not the workdir's own config ref, when resolution fails (regression)",
    () => {
      // The pre-connect `linkedRefForCache` chain must check `flags.projectRef`
      // FIRST — before config.toml's `project_id` and the `.temp/project-ref`
      // file — so a `--project-ref` override still wins even when `resolve()`
      // fails before ever returning its own `ref`. `opts.projectId` here stands
      // in for the workdir's own linked ref (e.g. config.toml `project_id`);
      // it must lose to the flag.
      const FLAG_REF = "flagflagflagflagflag";
      const { layer, cache } = setup({
        projectId: Option.some("abcdefghijklmnopqrst"),
        resolveFails: true,
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbDump(
          flags({ linked: Option.some(true), projectRef: Option.some(FLAG_REF) }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(cache.cached).toBe(true);
        expect(cache.cachedRef).toBe(FLAG_REF);
        expect(cache.cachedRef).not.toBe("abcdefghijklmnopqrst");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("does not cache when the linked ref is unknown and resolution fails", () => {
    // No config project_id and no .temp/project-ref file (workdir is a throwaway
    // path), so the up-front `loadProjectRef` pre-capture itself fails "not linked"
    // (linkedFails) before `resolve()` is ever reached; the cache is only written
    // when a ref is known, so nothing is cached.
    const { layer, cache } = setup({ resolveFails: true, linkedFails: true });
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

  it.live("dumps the project given via --project-ref without a linked workdir", () => {
    // No fixed `opts.ref` fixture — only the flag can resolve a ref for the
    // resolver call and the linked-project cache.
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, cache, resolver } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      stdout: "CREATE SCHEMA public;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ linked: Option.some(true), projectRef: Option.some(FLAG_REF) }));
      expect(resolver.calls[0]?.linkedProjectRef).toEqual(Option.some(FLAG_REF));
      expect(cache.cached).toBe(true);
      expect(cache.cachedRef).toBe(FLAG_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("--project-ref overrides an already-linked workdir's project ref", () => {
    const FLAG_REF = "flagflagflagflagflag";
    // The workdir already resolves to a fixed ref (e.g. via .temp/project-ref) —
    // the flag must win over it.
    const { layer, cache } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      ref: "abcdefghijklmnopqrst",
      stdout: "CREATE SCHEMA public;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDump(flags({ linked: Option.some(true), projectRef: Option.some(FLAG_REF) }));
      expect(cache.cached).toBe(true);
      expect(cache.cachedRef).toBe(FLAG_REF);
      expect(cache.cachedRef).not.toBe("abcdefghijklmnopqrst");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "rejects a malformed --project-ref on the linked path before resolving or caching",
    () => {
      // The pre-capture now runs the SAME validated `loadProjectRef` the resolver
      // would raise right after (codex review on dump.handler.ts:182), so a malformed
      // flag value must fail fast — never reaching `resolver.resolve()` (no
      // connection/API work) and never writing the linked-project cache (no
      // `GET /v1/projects/*`).
      const { layer, cache, resolver } = setup();
      return Effect.gen(function* () {
        const exit = yield* legacyDbDump(
          flags({ linked: Option.some(true), projectRef: Option.some("BADREF") }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failMessage(exit)).toBe(INVALID_PROJECT_REF_MESSAGE);
        expect(resolver.calls).toEqual([]);
        expect(cache.cached).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("rejects --project-ref combined with an explicit --local target", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, resolver, cache } = setup({ isLocal: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDump(
        flags({ local: Option.some(true), projectRef: Option.some(FLAG_REF) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      );
      expect(resolver.calls).toEqual([]);
      expect(cache.cached).toBe(false);
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
    // Any fallback-resolution error reports the original pg_dump failure — the
    // optional retry must not replace it.
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
      // The IPv6 pooler guidance is attached on the no-fallback path; the bare
      // container error must carry it.
      expect(failSuggestion(exit)).toContain(
        "Your network does not support IPv6, which is required for direct connections",
      );
      expect(failSuggestion(exit)).toContain("IPv4 transaction pooler");
    }).pipe(Effect.provide(layer));
  });

  it.live("linked: attaches the IPv6 suggestion when the pooler retry also fails", () => {
    // The IPv6 pooler guidance is also attached to the retry's stderr when the
    // pooler retry also fails; an IPv6 retry failure surfaces the same guidance.
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
