import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import {
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag, LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { legacyMigrationDown } from "./down.handler.ts";
import type { LegacyMigrationDownFlags } from "./down.command.ts";

const LIST_SQL = "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly args?: ReadonlyArray<string>;
  readonly yes?: boolean;
  readonly confirm?: boolean;
  readonly remote?: ReadonlyArray<string>;
  readonly failDrop?: boolean;
  readonly config?: string;
  readonly seedTable?: ReadonlyArray<{ path: string; hash: string }>;
}

const SELECT_SEED = "SELECT path, hash FROM supabase_migrations.seed_files";

function setup(workdir: string, opts: SetupOpts = {}) {
  if (opts.config !== undefined) {
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), opts.config);
  }
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.confirm === undefined ? undefined : [opts.confirm],
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const execs: Array<string> = [];
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];

  const resolver = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (_flags: LegacyDbConfigFlags) =>
      Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: true,
        ref: Option.none(),
      } satisfies LegacyResolvedDbConfig),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const connection = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
        exec: (sql: string) =>
          Effect.suspend(() => {
            execs.push(sql);
            return opts.failDrop === true && sql.startsWith("do $$")
              ? Effect.fail(new LegacyDbExecError({ message: "permission denied" }))
              : Effect.void;
          }),
        query: (sql: string, params?: ReadonlyArray<unknown>) =>
          Effect.suspend(() => {
            queries.push({ sql, params });
            if (sql === LIST_SQL)
              return Effect.succeed((opts.remote ?? []).map((version) => ({ version })));
            if (sql === SELECT_SEED) return Effect.succeed([...(opts.seedTable ?? [])]);
            return Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
          }),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
      }),
  });

  const projectRef = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(LEGACY_VALID_REF),
    resolveForLink: () => Effect.succeed(LEGACY_VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(LEGACY_VALID_REF)),
    loadProjectRef: () => Effect.succeed(LEGACY_VALID_REF),
    promptProjectRef: () => Effect.succeed(LEGACY_VALID_REF),
  });

  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    resolver,
    connection,
    projectRef,
    mockLegacyCliConfig({ workdir }),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    BunServices.layer,
  );
  return { layer, out, telemetry, execs, queries };
}

const flags = (over: Partial<LegacyMigrationDownFlags> = {}): LegacyMigrationDownFlags => ({
  last: over.last ?? 1,
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? true,
});

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");
const seed = (workdir: string, name: string, body = "create table a;\n") => {
  const dir = join(workdir, "supabase", "migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
};

const tmp = useLegacyTempWorkdir();

describe("legacy migration down", () => {
  it.live("rejects --last 0", () => {
    const { layer } = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationDown(flags({ last: 0 })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyMigrationLastZeroError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --last >= total applied migrations", () => {
    const { layer } = setup(tmp.current, { remote: ["20240101000000"] });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationDown(flags({ last: 1 })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe(
          "LegacyMigrationLastTooLargeError",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("reverts to the target version on confirm (drop + migrate&seed)", () => {
    seed(tmp.current, "20240101000000_a.sql");
    const { layer, out, execs, queries } = setup(tmp.current, {
      confirm: true,
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationDown(flags({ last: 1 }));
      expect(stripAnsi(out.stderrText)).toContain("Resetting database to version: 20240101000000");
      // dropped user schemas, then re-applied the migration <= target version.
      expect(execs.some((sql) => sql.startsWith("do $$"))).toBe(true);
      expect(
        queries.some(
          (q) =>
            q.sql.includes("INSERT INTO supabase_migrations") && q.params?.[0] === "20240101000000",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("cancels on a declined prompt", () => {
    seed(tmp.current, "20240101000000_a.sql");
    const { layer, execs } = setup(tmp.current, {
      confirm: false,
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationDown(flags({ last: 1 })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyOperationCanceledError");
      }
      expect(execs.some((sql) => sql.startsWith("do $$"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("defaults to NO (cancels) in json mode without --yes", () => {
    const { layer } = setup(tmp.current, {
      format: "json",
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationDown(flags({ last: 1 })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyOperationCanceledError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured result in json with --yes", () => {
    seed(tmp.current, "20240101000000_a.sql");
    const { layer, out } = setup(tmp.current, {
      format: "json",
      yes: true,
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationDown(flags({ last: 1 }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migrations reverted",
          data: { version: "20240101000000", last: 1 },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a drop-schema failure", () => {
    seed(tmp.current, "20240101000000_a.sql");
    const { layer } = setup(tmp.current, {
      confirm: true,
      remote: ["20240101000000", "20240102000000"],
      failDrop: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationDown(flags({ last: 1 })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyMigrationDropError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("seeds data from a new seed file and records its hash", () => {
    seed(tmp.current, "20240101000000_a.sql");
    writeFileSync(join(tmp.current, "supabase", "seed.sql"), "insert into a values (1);\n");
    const { layer, out, queries } = setup(tmp.current, {
      confirm: true,
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationDown(flags({ last: 1 }));
      expect(stripAnsi(out.stderrText)).toContain("Seeding data from supabase/seed.sql...");
      expect(
        queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations.seed_files")),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("skips an unchanged seed file", () => {
    seed(tmp.current, "20240101000000_a.sql");
    const body = "insert into a values (1);\n";
    writeFileSync(join(tmp.current, "supabase", "seed.sql"), body);
    const hash = createHash("sha256").update(body).digest("hex");
    const { layer, out, queries } = setup(tmp.current, {
      confirm: true,
      remote: ["20240101000000", "20240102000000"],
      seedTable: [{ path: "supabase/seed.sql", hash }],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationDown(flags({ last: 1 }));
      expect(stripAnsi(out.stderrText)).not.toContain("Seeding data from");
      expect(
        queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations.seed_files")),
      ).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("updates the recorded hash (without re-running) for a changed seed file", () => {
    seed(tmp.current, "20240101000000_a.sql");
    writeFileSync(join(tmp.current, "supabase", "seed.sql"), "insert into a values (2);\n");
    const { layer, out, execs, queries } = setup(tmp.current, {
      confirm: true,
      remote: ["20240101000000", "20240102000000"],
      seedTable: [{ path: "supabase/seed.sql", hash: "stale-hash-does-not-match" }],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationDown(flags({ last: 1 }));
      // Dirty seed → "Updating seed hash" + hash UPSERT, but the seed SQL is NOT re-run.
      expect(stripAnsi(out.stderrText)).toContain("Updating seed hash to supabase/seed.sql...");
      expect(
        queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations.seed_files")),
      ).toBe(true);
      expect(execs).not.toContain("insert into a values (2)");
    }).pipe(Effect.provide(layer));
  });

  it.live("skips migration apply when db.migrations.enabled = false", () => {
    seed(tmp.current, "20240101000000_a.sql");
    const { layer, queries } = setup(tmp.current, {
      confirm: true,
      remote: ["20240101000000", "20240102000000"],
      config: "[db.migrations]\nenabled = false\n",
    });
    return Effect.gen(function* () {
      yield* legacyMigrationDown(flags({ last: 1 }));
      // No migration re-applied when migrations are disabled.
      expect(queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
