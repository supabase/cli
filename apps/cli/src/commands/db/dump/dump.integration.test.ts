import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { mockOutput, mockTty, processEnvLayer } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { DnsResolverFlag, NetworkIdFlag } from "../../../command-internal/global-flags.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import {
  InvalidProjectRefError,
  ProjectRefNotLinkedError,
} from "../../../config/project-ref.errors.ts";
import {
  INVALID_PROJECT_REF_MESSAGE,
  ProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
  PROJECT_REF_PATTERN,
} from "../../../config/project-ref.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { DbConfigFlags } from "../../../command-internal/db-config.types.ts";
import type { PgConnInput } from "../../../command-internal/db-connection.service.ts";
import { DbConfigConnectTempRoleError } from "../../../command-internal/db-config.errors.ts";
import { DockerRunError } from "../../../command-internal/docker-run.errors.ts";
import { DockerRun, type DockerRunOpts } from "../../../command-internal/docker-run.service.ts";
import type { DbDumpFlags } from "./dump.command.ts";
import { dbDump } from "./dump.handler.ts";
import { stackBackendLayer } from "../../../command-internal/stack-backend.ts";
import { StackApi } from "../../../command-internal/stack-api.ts";
import { StackIdSchema, type EffectStack } from "@supabase/stack/effect";

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

function mockResolver(opts: {
  conn?: PgConnInput;
  isLocal?: boolean;
  poolerFallback?: Option.Option<PgConnInput>;
  poolerFallbackFails?: boolean;
  resolveFails?: boolean;
  ref?: string;
}) {
  const calls: DbConfigFlags[] = [];
  const fallbackCalls: DbConfigFlags[] = [];
  const layer = Layer.succeed(DbConfigResolver, {
    resolve: (flags) => {
      calls.push(flags);
      // Simulates connection resolution failing (IPv6 probe/pooler/temp login-role)
      // after the ref is already loaded.
      if (opts.resolveFails === true) {
        return Effect.fail(
          new DbConfigConnectTempRoleError({ message: "failed to create temp role" }),
        );
      }
      // A threaded `--project-ref` flag wins over the fixed `opts.ref` fixture,
      // matching real resolver precedence.
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
        ? Effect.fail(new DbConfigConnectTempRoleError({ message: "failed to create temp role" }))
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
 * Mocks `ProjectRefResolver` for the up-front `loadProjectRef` pre-capture, mirroring
 * push/diff's identical mock: an explicit `--project-ref` flag wins, a malformed value
 * fails with `InvalidProjectRefError`, and `opts.projectId` stands in for
 * `CommandSettings.projectId` consulted before falling back to `opts.ref`.
 */
function mockProjectRefResolver(opts: {
  projectId: Option.Option<string>;
  ref?: string;
  linkedFails?: boolean;
}) {
  const validate = (ref: string) =>
    PROJECT_REF_PATTERN.test(ref)
      ? Effect.succeed(ref)
      : Effect.fail(new InvalidProjectRefError({ ref, message: INVALID_PROJECT_REF_MESSAGE }));
  const layer = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(opts.ref ?? VALID_REF),
    resolveForLink: () => Effect.succeed(opts.ref ?? VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(opts.ref ?? VALID_REF)),
    loadProjectRef: (flagValue: Option.Option<string>) => {
      if (Option.isSome(flagValue) && flagValue.value.length > 0) {
        return validate(flagValue.value);
      }
      if (Option.isSome(opts.projectId)) {
        return validate(opts.projectId.value);
      }
      return opts.linkedFails === true
        ? Effect.fail(new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }))
        : Effect.succeed(opts.ref ?? VALID_REF);
    },
    promptProjectRef: () => Effect.succeed(opts.ref ?? VALID_REF),
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
  const allOpts: DockerRunOpts[] = [];
  const queue = [...(opts.results ?? [])];
  const layer = Layer.succeed(DockerRun, {
    run: () => Effect.succeed(0),
    runCapture: (runOpts) => {
      allOpts.push(runOpts);
      if (opts.runFails === true) {
        return Effect.fail(
          new DockerRunError({
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
            new DockerRunError({
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
  conn?: PgConnInput;
  isLocal?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  runFails?: boolean;
  results?: ReadonlyArray<DockerResult>;
  poolerFallback?: Option.Option<PgConnInput>;
  poolerFallbackFails?: boolean;
  networkId?: string;
  workdir?: string;
  projectId?: Option.Option<string>;
  resolveFails?: boolean;
  ref?: string;
  linkedFails?: boolean;
  platform?: NodeJS.Platform;
  stdoutIsPipe?: boolean;
  env?: Readonly<Record<string, string>>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
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
    mockCommandSettings({
      workdir: opts.workdir ?? "/work/project",
      projectId: opts.projectId ?? Option.none(),
    }),
    telemetry.layer,
    cache.layer,
    runtimeInfoLayer(opts.platform ?? "linux"),
    mockTty({ stdoutIsPipe: opts.stdoutIsPipe }),
    processEnvLayer(opts.env ?? {}),
    Layer.succeed(
      NetworkIdFlag,
      opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
    ),
    Layer.succeed(DnsResolverFlag, "native"),
    BunServices.layer,
  );
  return { layer, out, telemetry, resolver, docker, cache };
}

const flags = (over: Partial<DbDumpFlags> = {}): DbDumpFlags => ({
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

describe("db dump integration", () => {
  const tmp = useTempWorkdir();

  it.live("errors when --use-copy is used without --data-only", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* dbDump(flags({ useCopy: true, local: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(`required flag(s) "data-only" not set`);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "allows --use-copy with an explicit --data-only=false (Go required check is presence)",
    () => {
      const { layer } = setup({ isLocal: true, stdout: "SELECT 1;\n" });
      return Effect.gen(function* () {
        const exit = yield* dbDump(
          flags({ useCopy: true, dataOnly: Option.some(false), local: Option.some(true) }),
        ).pipe(Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("errors when --exclude is used without --data-only", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* dbDump(
        flags({ exclude: ["public.users"], local: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(`required flag(s) "data-only" not set`);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects combining --data-only and --role-only", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* dbDump(
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
      const exit = yield* dbDump(
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
      const exit = yield* dbDump(flags({ schema: ["public"], roleOnly: Option.some(true) })).pipe(
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
      const exit = yield* dbDump(
        flags({ linked: Option.some(true), local: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --linked=false --local as a target conflict (Go flag.Changed)", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* dbDump(
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
      const exit = yield* dbDump(
        flags({ dataOnly: Option.some(false), roleOnly: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [role-only data-only] are set none of the others can be; [data-only role-only] were all set",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --local=false as an explicit local target (Go ParseDatabaseConfig)", () => {
    const { layer, resolver } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* dbDump(flags({ local: Option.some(false), dryRun: true }));
      expect(resolver.calls[0]?.connType).toBe("local");
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the expanded pg_dump script on --dry-run without running a container", () => {
    const { layer, out, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* dbDump(flags({ dryRun: true, local: Option.some(true) }));
      expect(out.stderrText).toContain("DRY RUN: *only* printing the pg_dump script to console.");
      expect(out.stderrText).toContain("Dumping schemas from local database...");
      expect(out.stdoutText).toContain('export PGHOST="127.0.0.1"');
      expect(docker.lastOpts).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the post-run Dumped-schema message on --dry-run --file without writing", () => {
    const filePath = join(tmp.current, "dry.sql");
    const { layer, out, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* dbDump(flags({ dryRun: true, local: Option.some(true), file: Option.some(filePath) }));
      expect(out.stderrText).toContain("DRY RUN: *only* printing the pg_dump script to console.");
      expect(out.stderrText).toContain(`Dumped schema to`);
      expect(out.stderrText).toContain(filePath);
      expect(docker.lastOpts).toBeUndefined();
      expect(existsSync(filePath)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("treats an explicit --file '' as stdout on --dry-run (Go: len(path) > 0)", () => {
    const { layer, out, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* dbDump(flags({ dryRun: true, local: Option.some(true), file: Option.some("") }));
      expect(out.stderrText).toContain("DRY RUN: *only* printing the pg_dump script to console.");
      expect(out.stderrText).not.toContain("Dumped schema to");
      expect(docker.lastOpts).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("validates the merged config before the --dry-run print (Go root PreRun order)", () => {
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      ["[remotes.staging]", 'project_id = "staging"', ""].join("\n"),
    );
    const { layer, out } = setup({ isLocal: true, workdir: tmp.current });
    return Effect.gen(function* () {
      const exit = yield* dbDump(flags({ dryRun: true, local: Option.some(true) })).pipe(
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
      yield* dbDump(flags({ local: Option.some(true) }));
      expect(out.stderrText).toContain("Dumping schemas from local database...");
      expect(out.stdoutText).toBe("CREATE SCHEMA public;\n");
      expect(docker.lastOpts?.cmd).toEqual([
        "bash",
        "-c",
        expect.stringContaining("pg_dump"),
        "--",
      ]);
      expect(docker.lastOpts?.network).toEqual({ _tag: "host" });
      expect(docker.lastOpts?.securityOpt).toEqual([]);
      expect(docker.lastOpts?.env["EXCLUDED_SCHEMAS"]).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("dumps only data with column inserts", () => {
    const { layer, out, docker } = setup({ isLocal: true, stdout: "INSERT INTO ...;\n" });
    return Effect.gen(function* () {
      yield* dbDump(flags({ dataOnly: Option.some(true), local: Option.some(true) }));
      expect(out.stderrText).toContain("Dumping data from local database...");
      expect(docker.lastOpts?.env["EXTRA_FLAGS"]).toBe("--column-inserts --rows-per-insert 100000");
    }).pipe(Effect.provide(layer));
  });

  it.live("dumps only data without column inserts when --use-copy is set", () => {
    const { layer, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* dbDump(
        flags({ dataOnly: Option.some(true), useCopy: true, local: Option.some(true) }),
      );
      expect(docker.lastOpts?.env["EXTRA_FLAGS"]).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("dumps only roles", () => {
    const { layer, out, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* dbDump(flags({ roleOnly: Option.some(true), local: Option.some(true) }));
      expect(out.stderrText).toContain("Dumping roles from local database...");
      expect(docker.lastOpts?.env["RESERVED_ROLES"]).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("limits the dump to selected schemas", () => {
    const { layer, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* dbDump(flags({ schema: ["public", "auth"], local: Option.some(true) }));
      expect(docker.lastOpts?.env["EXTRA_FLAGS"]).toBe("--schema=public|auth");
    }).pipe(Effect.provide(layer));
  });

  it.live("joins a multi-schema selection into EXTRA_FLAGS with pipes", () => {
    // The handler receives an already-split array (CSV-split at the flag level by
    // `parseSchemaFlags`) and the env builder pipe-joins it.
    const { layer, docker } = setup({ isLocal: true });
    return Effect.gen(function* () {
      yield* dbDump(flags({ schema: ["public", "auth"], local: Option.some(true) }));
      expect(docker.lastOpts?.env["EXTRA_FLAGS"]).toBe("--schema=public|auth");
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves a relative --file against the workdir", () => {
    const { layer } = setup({
      isLocal: true,
      stdout: "CREATE SCHEMA public;\n",
      workdir: tmp.current,
    });
    return Effect.gen(function* () {
      yield* dbDump(flags({ local: Option.some(true), file: Option.some("out.sql") }));
      expect(readFileSync(join(tmp.current, "out.sql"), "utf8")).toBe("CREATE SCHEMA public;\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("honors --network-id over host networking", () => {
    const { layer, docker } = setup({ isLocal: true, networkId: "custom_net" });
    return Effect.gen(function* () {
      yield* dbDump(flags({ local: Option.some(true) }));
      expect(docker.lastOpts?.network).toEqual({ _tag: "named", name: "custom_net" });
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "resolves the pg_dump network via SUPABASE_NETWORK_ID from supabase/.env when neither the flag nor the ambient env is set",
    () => {
      // A `SUPABASE_NETWORK_ID` sourced only from `supabase/.env` still overrides host
      // networking.
      const prev = process.env["SUPABASE_NETWORK_ID"];
      delete process.env["SUPABASE_NETWORK_ID"];
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_NETWORK_ID=dotenv-net\n");
      const { layer, docker } = setup({ isLocal: true, workdir: tmp.current });
      return Effect.gen(function* () {
        yield* dbDump(flags({ local: Option.some(true) }));
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
      yield* dbDump(flags({}));
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
      const exit = yield* dbDump(flags({ linked: Option.some(true) })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(resolver.calls[0]).toMatchObject({ connType: "linked" });
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "caches the flag ref, not the workdir's own config ref, when resolution fails (regression)",
    () => {
      // `linkedRefForCache` must check `flags.projectRef` before config.toml's
      // `project_id`, so the flag still wins even when `resolve()` fails first.
      const FLAG_REF = "flagflagflagflagflag";
      const { layer, cache } = setup({
        projectId: Option.some("abcdefghijklmnopqrst"),
        resolveFails: true,
      });
      return Effect.gen(function* () {
        const exit = yield* dbDump(
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
    // No config project_id or .temp/project-ref file, so the up-front pre-capture
    // itself fails "not linked" before `resolve()` is reached; nothing is cached.
    const { layer, cache } = setup({ resolveFails: true, linkedFails: true });
    return Effect.gen(function* () {
      const exit = yield* dbDump(flags({ linked: Option.some(true) })).pipe(Effect.exit);
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
      yield* dbDump(flags({ linked: Option.some(true) }));
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("dumps the project given via --project-ref without a linked workdir", () => {
    // No fixed `opts.ref`; only the flag can resolve a ref here.
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, cache, resolver } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      stdout: "CREATE SCHEMA public;\n",
    });
    return Effect.gen(function* () {
      yield* dbDump(flags({ linked: Option.some(true), projectRef: Option.some(FLAG_REF) }));
      expect(resolver.calls[0]?.linkedProjectRef).toEqual(Option.some(FLAG_REF));
      expect(cache.cached).toBe(true);
      expect(cache.cachedRef).toBe(FLAG_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("--project-ref overrides an already-linked workdir's project ref", () => {
    const FLAG_REF = "flagflagflagflagflag";
    // A distinct fixed ref proves the flag, not the workdir's own ref, wins.
    const { layer, cache } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      ref: "abcdefghijklmnopqrst",
      stdout: "CREATE SCHEMA public;\n",
    });
    return Effect.gen(function* () {
      yield* dbDump(flags({ linked: Option.some(true), projectRef: Option.some(FLAG_REF) }));
      expect(cache.cached).toBe(true);
      expect(cache.cachedRef).toBe(FLAG_REF);
      expect(cache.cachedRef).not.toBe("abcdefghijklmnopqrst");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "rejects a malformed --project-ref on the linked path before resolving or caching",
    () => {
      // `loadProjectRef` validates before `resolver.resolve()` runs, so a malformed
      // flag fails fast with no connection/API work and no cache write.
      const { layer, cache, resolver } = setup();
      return Effect.gen(function* () {
        const exit = yield* dbDump(
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
      const exit = yield* dbDump(
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
      yield* dbDump(flags({ local: Option.some(true), file: Option.some(filePath) }));
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
      const exit = yield* dbDump(flags({ local: Option.some(true) })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe("error running container: exit 1");
    }).pipe(Effect.provide(layer));
  });

  const POOLER_CONN: PgConnInput = {
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
      yield* dbDump(flags());
      expect(docker.allOpts).toHaveLength(2);
      expect(resolver.fallbackCalls).toHaveLength(1);
      expect(resolver.fallbackCalls[0]).toMatchObject({ connType: "linked" });
      expect(docker.allOpts[1]?.env["PGHOST"]).toBe(POOLER_CONN.host);
      expect(out.stderrText).toContain("does not support IPv6");
      expect(out.stderrText).toContain("Retrying via the IPv4 connection pooler.");
      expect(out.stdoutText).toBe("CREATE SCHEMA x;\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("linked: preserves the original dump error when the pooler fallback fails", () => {
    const { layer, resolver, docker } = setup({
      conn: REMOTE_CONN,
      isLocal: false,
      poolerFallbackFails: true,
      results: [{ exitCode: 1, stderr: IPV6_STDERR }],
    });
    return Effect.gen(function* () {
      const exit = yield* dbDump(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
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
      const exit = yield* dbDump(flags()).pipe(Effect.exit);
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
      const exit = yield* dbDump(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe("error running container: exit 1");
      expect(resolver.fallbackCalls).toHaveLength(1);
      expect(docker.allOpts).toHaveLength(1);
      expect(failSuggestion(exit)).toContain(
        "Your network does not support IPv6, which is required for direct connections",
      );
      expect(failSuggestion(exit)).toContain("IPv4 transaction pooler");
    }).pipe(Effect.provide(layer));
  });

  it.live("linked: attaches the IPv6 suggestion when the pooler retry also fails", () => {
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
      const exit = yield* dbDump(flags()).pipe(Effect.exit);
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
      const exit = yield* dbDump(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failSuggestion(exit)).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("json mode: emits the SQL to stdout with no machine envelope", () => {
    const { layer, out } = setup({ format: "json", isLocal: true, stdout: "CREATE SCHEMA x;\n" });
    return Effect.gen(function* () {
      yield* dbDump(flags({ local: Option.some(true) }));
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
      yield* dbDump(flags({ local: Option.some(true) }));
      expect(out.stdoutText).toBe("CREATE SCHEMA x;\n");
    }).pipe(Effect.provide(layer));
  });

  const UNICODE_SQL = "insert into t values ('Oranges \u{1F34A}', 'd\u00f6Terra');\n";
  const NON_ASCII_WARNING = "The dump contains non-ASCII characters";
  const PIPED_WIN32 = { platform: "win32", stdoutIsPipe: true } as const;

  // A shell pipeline gets a genuine FIFO for the pipe probe below; Bun's spawnSync
  // "pipe" stdio is a socketpair, which fstats as a socket instead.
  const PROBE = 'process.stdout.write(String(require("node:fs").fstatSync(1).isFIFO()));';

  it.skipIf(process.platform === "win32")("classifies a real piped stdout as a pipe", () => {
    const result = spawnSync("/bin/sh", ["-c", `"${process.execPath}" -e '${PROBE}' | cat`], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("true");
  });

  it.skipIf(process.platform === "win32")("classifies a file-backed stdout as not a pipe", () => {
    const file = join(tmp.current, "pipe-probe.txt");
    const fd = openSync(file, "w");
    try {
      const result = spawnSync(process.execPath, ["-e", PROBE], {
        stdio: ["ignore", fd, "inherit"],
      });
      expect(result.status).toBe(0);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(file, "utf8")).toBe("false");
  });

  it.live("windows: warns when a piped stdout dump contains non-ASCII text", () => {
    const { layer, out } = setup({
      isLocal: true,
      stdout: UNICODE_SQL,
      ...PIPED_WIN32,
      env: { MSYSTEM: "" },
    });
    return Effect.gen(function* () {
      yield* dbDump(flags({ local: Option.some(true) }));
      expect(out.stdoutText).toBe(UNICODE_SQL);
      expect(out.stderrText).toContain("WARNING:");
      expect(out.stderrText).toContain(NON_ASCII_WARNING);
      expect(out.stderrText).toContain("re-run with --file");
    }).pipe(Effect.provide(layer));
  });

  it.live("stays silent when a piped Windows dump writes to --file", () => {
    const { layer, out } = setup({
      isLocal: true,
      stdout: UNICODE_SQL,
      ...PIPED_WIN32,
      workdir: tmp.current,
    });
    return Effect.gen(function* () {
      yield* dbDump(flags({ local: Option.some(true), file: Option.some("out.sql") }));
      expect(readFileSync(join(tmp.current, "out.sql"), "utf8")).toBe(UNICODE_SQL);
      expect(out.stderrText).not.toContain(NON_ASCII_WARNING);
    }).pipe(Effect.provide(layer));
  });

  const SILENT: ReadonlyArray<[string, Partial<SetupOpts>]> = [
    ["on non-Windows platforms", { stdoutIsPipe: true }],
    [
      "when stdout is not a pipe (TTY, or cmd.exe / Git Bash `>` file handle)",
      { platform: "win32" },
    ],
    [
      "in a Git Bash / MSYS session (byte-faithful mintty pipe)",
      { ...PIPED_WIN32, env: { MSYSTEM: "MINGW64" } },
    ],
    ["under a mintty terminal outside MSYS", { ...PIPED_WIN32, env: { TERM_PROGRAM: "mintty" } }],
    ["when the dump is ASCII-only", { ...PIPED_WIN32, stdout: "select 'plain \x7f';\n" }],
  ];
  for (const [scenario, over] of SILENT) {
    it.live(`stays silent ${scenario}`, () => {
      const { layer, out } = setup({ isLocal: true, stdout: UNICODE_SQL, ...over });
      return Effect.gen(function* () {
        yield* dbDump(flags({ local: Option.some(true) }));
        expect(out.stdoutText).toBe(over.stdout ?? UNICODE_SQL);
        expect(out.stderrText).not.toContain(NON_ASCII_WARNING);
      }).pipe(Effect.provide(layer));
    });
  }

  const DUMP_STACK_ID = StackIdSchema.make("d".repeat(64));
  const unusedDump = () => Effect.die("unused");
  const unusedDumpEffect = Effect.die("unused");
  const dumpStackApi = (runtime: { kind: "native" } | { kind: "container"; engine: "docker" }) => {
    const stack: EffectStack = {
      id: DUMP_STACK_ID,
      status: unusedDumpEffect,
      credentials: unusedDumpEffect,
      prepare: unusedDump,
      start: unusedDump,
      stop: unusedDumpEffect,
      destroy: unusedDumpEffect,
      resetDatabase: unusedDumpEffect,
      logs: unusedDump,
      followLogs: () => Stream.empty,
    };
    return Layer.succeed(StackApi, {
      createStack: unusedDump,
      findStack: () =>
        Effect.succeed(
          Option.some({
            id: DUMP_STACK_ID,
            projectRoot: "/work/project",
            name: "default",
            branchContext: "main",
            runtime,
            desiredLifecycle: "running",
          }),
        ),
      discoverStacks: unusedDump,
      openStack: () => Effect.succeed(stack),
      inspectStack: unusedDump,
    });
  };

  it.live(
    "dump --local on the stack backend fails instead of using Docker when no stack exists",
    () => {
      const { layer, docker } = setup({ isLocal: true, stdout: "-- schema\n" });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(dbDump(flags({ local: Option.some(true) })));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failMessage(exit)).toContain("Could not determine the stack runtime");
        expect(docker.lastOpts).toBeUndefined();
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layer,
            stackBackendLayer("stack"),
            Layer.succeed(StackApi, {
              createStack: unusedDump,
              findStack: () => Effect.succeed(Option.none()),
              discoverStacks: unusedDump,
              openStack: unusedDump,
              inspectStack: unusedDump,
            }),
          ),
        ),
      );
    },
  );

  it.live("dump --local on a docker stack never uses PGHOST=db", () => {
    const { layer, docker } = setup({
      isLocal: true,
      stdout: "-- schema\n",
      platform: "darwin",
    });
    return Effect.gen(function* () {
      yield* dbDump(flags({ local: Option.some(true) }));
      expect(docker.lastOpts?.env["PGHOST"]).toBe("host.docker.internal");
      expect(docker.lastOpts?.env["PGHOST"]).not.toBe("db");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          stackBackendLayer("stack"),
          dumpStackApi({ kind: "container", engine: "docker" }),
        ),
      ),
    );
  });

  it.live("dump --local on a docker stack ignores compose SUPABASE_NETWORK_ID", () => {
    const { layer, docker } = setup({
      isLocal: true,
      stdout: "-- schema\n",
      platform: "darwin",
      env: { SUPABASE_NETWORK_ID: "supabase_network_test" },
    });
    return Effect.gen(function* () {
      yield* dbDump(flags({ local: Option.some(true) }));
      expect(docker.lastOpts?.network).toEqual({ _tag: "host" });
      expect(docker.lastOpts?.env["PGHOST"]).toBe("host.docker.internal");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          stackBackendLayer("stack"),
          dumpStackApi({ kind: "container", engine: "docker" }),
        ),
      ),
    );
  });

  it.live("dump --local on a native stack uses PATH pg_dump, not a tool container", () => {
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      'project_id = "test"\n[db]\nmajor_version = 17\n',
    );
    const spawned: Array<string> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const name = command._tag === "StandardCommand" ? command.command : "";
        spawned.push(name);
        const stdoutText = name === "pg_dump" ? "pg_dump (PostgreSQL) 17.4\n" : "-- schema\n";
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          stdout: Stream.fromIterable([new TextEncoder().encode(stdoutText)]),
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const { layer, docker, out } = setup({
      isLocal: true,
      workdir: tmp.current,
    });
    return Effect.gen(function* () {
      yield* dbDump(flags({ local: Option.some(true) }));
      expect(docker.lastOpts).toBeUndefined();
      expect(spawned).toContain("pg_dump");
      expect(spawned).toContain("bash");
      expect(out.stdoutText).toContain("-- schema");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          stackBackendLayer("stack"),
          dumpStackApi({ kind: "native" }),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });
});
