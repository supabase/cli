import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyYesFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import { legacyDbReset } from "./reset.handler.ts";
import type { LegacyDbResetFlags } from "./reset.command.ts";

const LIST_MIGRATIONS =
  "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";
const SELECT_SEEDS = "SELECT path, hash FROM supabase_migrations.seed_files";

const CONN: LegacyPgConnInput = {
  host: "db.example.supabase.co",
  port: 5432,
  user: "postgres",
  password: "secret",
  database: "postgres",
};

const DEFAULT_FLAGS: LegacyDbResetFlags = {
  dbUrl: Option.none(),
  linked: false,
  local: false,
  noSeed: false,
  version: Option.none(),
  last: Option.none(),
};

function mockResolver(opts: { isLocal: boolean; ref?: string; omitRef?: boolean }) {
  return Layer.succeed(LegacyDbConfigResolver, {
    resolve: (_flags: LegacyDbConfigFlags) =>
      Effect.succeed(
        (opts.omitRef === true
          ? { conn: CONN, isLocal: opts.isLocal }
          : {
              conn: CONN,
              isLocal: opts.isLocal,
              ref: opts.ref !== undefined ? Option.some(opts.ref) : Option.none(),
            }) satisfies LegacyResolvedDbConfig,
      ),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
}

function mockConnection(opts: { remoteSeeds?: Readonly<Record<string, string>> }) {
  const execs: Array<string> = [];
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        exec: (sql: string): Effect.Effect<void, LegacyDbExecError> =>
          Effect.sync(() => {
            execs.push(sql);
          }),
        query: (
          sql: string,
          params?: ReadonlyArray<unknown>,
        ): Effect.Effect<ReadonlyArray<Record<string, unknown>>, LegacyDbExecError> =>
          Effect.suspend(
            (): Effect.Effect<ReadonlyArray<Record<string, unknown>>, LegacyDbExecError> => {
              queries.push({ sql, params });
              if (sql === SELECT_SEEDS) {
                return Effect.succeed(
                  Object.entries(opts.remoteSeeds ?? {}).map(([path, hash]) => ({ path, hash })),
                );
              }
              if (sql === LIST_MIGRATIONS) return Effect.succeed([]);
              return Effect.succeed([]);
            },
          ),
      }),
  });
  return {
    layer,
    get execs() {
      return execs;
    },
    get queries() {
      return queries;
    },
  };
}

function mockProxy() {
  const calls: Array<{ args: ReadonlyArray<string>; env?: Record<string, string> }> = [];
  const layer = Layer.succeed(LegacyGoProxy, {
    exec: (args, opts) =>
      Effect.sync(() => {
        calls.push({ args, env: opts?.env });
      }),
    execCapture: () => Effect.succeed(""),
  });
  return {
    layer,
    get calls() {
      return calls;
    },
  };
}

function setup(
  workdir: string,
  opts: {
    toml?: string;
    files?: Readonly<Record<string, string>>;
    format?: OutputFormat;
    confirm?: ReadonlyArray<boolean>;
    args?: ReadonlyArray<string>;
    isLocal?: boolean;
    ref?: string;
    experimental?: boolean;
    remoteSeeds?: Readonly<Record<string, string>>;
    yes?: boolean;
    omitRef?: boolean;
  },
) {
  if (opts.toml !== undefined) {
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), opts.toml);
  }
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = join(workdir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  const out = mockOutput({ format: opts.format ?? "text", promptConfirmResponses: opts.confirm });
  const conn = mockConnection(opts);
  const proxy = mockProxy();
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedCache = mockLegacyLinkedProjectCacheTracked();

  const layer = Layer.mergeAll(
    out.layer,
    conn.layer,
    proxy.layer,
    mockResolver({
      isLocal: opts.isLocal ?? false,
      ref: opts.ref ?? LEGACY_VALID_REF,
      omitRef: opts.omitRef,
    }),
    mockLegacyCliConfig({ workdir }),
    BunServices.layer,
    Layer.succeed(CliArgs, { args: opts.args ?? ["db", "reset", "--linked"] }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? false),
    telemetry.layer,
    linkedCache.layer,
  );
  return { layer, out, conn, proxy, telemetry, linkedCache };
}

const migrationFile = (version: string, body = "create table t ();") => ({
  [`supabase/migrations/${version}_test.sql`]: body,
});

describe("legacy db reset", () => {
  const tmp = useLegacyTempWorkdir("supabase-db-reset-");

  it.live("delegates a local reset to the Go binary with telemetry disabled", () => {
    const { layer, proxy, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      args: ["db", "reset"],
      isLocal: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(proxy.calls).toHaveLength(1);
      expect(proxy.calls[0]!.args).toEqual(["db", "reset"]);
      expect(proxy.calls[0]!.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: "1" });
      // No native DB work on the delegated path.
      expect(conn.execs).toHaveLength(0);
    });
  });

  it.live("rejects mutually exclusive target flags", () => {
    const { layer } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      args: ["db", "reset", "--linked", "--local"],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("rejects --version together with --last", () => {
    const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        version: Option.some("20240101000000"),
        last: Option.some(1),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("[last version]");
    });
  });

  it.live("rejects a non-integer --version", () => {
    const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        version: Option.some("not-a-number"),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(JSON.stringify(exit.cause)).toContain("invalid version number");
    });
  });

  it.live("fails when --version has no matching migration file", () => {
    const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        version: Option.some("20240101000000"),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "glob supabase/migrations/20240101000000_*.sql: file does not exist",
        );
      }
    });
  });

  it.live("returns context canceled when the reset prompt is declined", () => {
    const { layer, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      confirm: [false],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("context canceled");
      expect(conn.execs).toHaveLength(0);
    });
  });

  it.live("drops schemas and applies migrations + seed on a confirmed remote reset", () => {
    const { layer, out, conn, linkedCache } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: {
        ...migrationFile("20240101000000"),
        "supabase/seed.sql": "insert into t values (1);",
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Resetting remote database...");
      // No "Connecting to ... database..." line (Go uses io.Discard).
      expect(out.stderrText).not.toContain("Connecting to");
      // Drop block ran, then the migration applied.
      expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
      expect(out.stderrText).toContain("Seeding data from supabase/seed.sql...");
      expect(linkedCache.cached).toBe(true);
    });
  });

  it.live("resets to a specific version, applying only migrations up to it", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: {
        ...migrationFile("20240101000000"),
        ...migrationFile("20240202000000"),
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        version: Option.some("20240101000000"),
      }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Resetting remote database to version: 20240101000000");
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
      expect(out.stderrText).not.toContain("Applying migration 20240202000000_test.sql...");
      expect(conn).toBeDefined();
    });
  });

  it.live("resolves --last to a version prefix", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: {
        ...migrationFile("20240101000000"),
        ...migrationFile("20240202000000"),
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      // last=1 → revert the most recent → reset to version 20240101000000.
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true, last: Option.some(1) }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Resetting remote database to version: 20240101000000");
    });
  });

  it.live("reverts all migrations when --last covers the full history", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { ...migrationFile("20240101000000"), ...migrationFile("20240202000000") },
      confirm: [true],
    });
    return Effect.gen(function* () {
      // last=2 with 2 local migrations → revert all → version "-".
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true, last: Option.some(2) }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Resetting remote database to version: -");
    });
  });

  it.live("skips seeding with --no-seed", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: {
        ...migrationFile("20240101000000"),
        "supabase/seed.sql": "insert into t values (1);",
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true, noSeed: true }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).not.toContain("Seeding data from");
    });
  });

  it.live("delegates an experimental remote reset to the Go binary", () => {
    const { layer, proxy } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      experimental: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      expect(proxy.calls).toHaveLength(1);
      expect(proxy.calls[0]!.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: "1" });
    });
  });

  it.live("forwards all flags to the Go binary on the delegated local path", () => {
    const { layer, proxy } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { ...migrationFile("20240101000000"), ...migrationFile("20240202000000") },
      args: ["db", "reset", "--local"],
      isLocal: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        local: true,
        noSeed: true,
        last: Option.some(1),
      }).pipe(Effect.provide(layer));
      expect(proxy.calls[0]!.args).toEqual(["db", "reset", "--local", "--no-seed", "--last", "1"]);
    });
  });

  it.live("forwards --db-url and --version when delegating a local db-url reset", () => {
    const { layer, proxy } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      args: ["db", "reset", "--db-url", "postgresql://localhost:54322/postgres"],
      isLocal: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        dbUrl: Option.some("postgresql://localhost:54322/postgres"),
        version: Option.some("20240101000000"),
      }).pipe(Effect.provide(layer));
      expect(proxy.calls[0]!.args).toEqual([
        "db",
        "reset",
        "--db-url",
        "postgresql://localhost:54322/postgres",
        "--version",
        "20240101000000",
      ]);
    });
  });

  it.live("resets a remote --db-url target without loading a remote config override", () => {
    const { layer, out, conn } = setup(tmp.current, {
      // No config file → embedded defaults (migrations + seed enabled).
      files: migrationFile("20240101000000"),
      args: ["db", "reset", "--db-url", "postgresql://db.example.com:5432/postgres"],
      isLocal: false,
      omitRef: true,
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        dbUrl: Option.some("postgresql://db.example.com:5432/postgres"),
      }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Resetting remote database...");
      expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
    });
  });

  it.live("announces a matching [remotes.*] override", () => {
    const { layer, out } = setup(tmp.current, {
      toml: `project_id = "base"\n\n[remotes.preview]\nproject_id = "${LEGACY_VALID_REF}"\n`,
      confirm: [true],
      ref: LEGACY_VALID_REF,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Loading config override: [remotes.preview]");
    });
  });

  it.live("skips migrations and seed when both are disabled in config", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.migrations]\nenabled = false\n\n[db.seed]\nenabled = false\n',
      files: {
        ...migrationFile("20240101000000"),
        "supabase/seed.sql": "insert into t values (1);",
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      // Schemas are still dropped, but nothing is applied or seeded.
      expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
      expect(out.stderrText).not.toContain("Applying migration");
      expect(out.stderrText).not.toContain("Seeding data from");
    });
  });

  it.live("emits a json result for a confirmed remote reset (--yes)", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      format: "json",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["target"]).toBe("remote");
    });
  });

  it.live("emits a json result for a confirmed remote reset", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      format: "json",
    });
    return Effect.gen(function* () {
      // json mode is non-interactive → prompt takes the default (false) → cancel.
      const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      // default-false prompt in non-text mode declines → context canceled.
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out).toBeDefined();
    });
  });
});
