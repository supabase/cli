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
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyMigrationsReadError } from "../../../shared/legacy-migration.errors.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { legacyMigrationList } from "./list.handler.ts";
import type { LegacyMigrationListFlags } from "./list.command.ts";

const LIST_SQL = "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly args?: ReadonlyArray<string>;
  readonly isLocal?: boolean;
  readonly remote?: ReadonlyArray<string>;
  readonly remoteError?: LegacyDbExecError;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const resolverCalls: Array<LegacyDbConfigFlags> = [];
  const resolver = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (flags: LegacyDbConfigFlags) => {
      resolverCalls.push(flags);
      return Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: opts.isLocal ?? false,
        ref: Option.some(LEGACY_VALID_REF),
      } satisfies LegacyResolvedDbConfig);
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const connection = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
        exec: () => Effect.void,
        query: (sql: string) =>
          Effect.suspend(() => {
            if (sql === LIST_SQL) {
              if (opts.remoteError !== undefined) return Effect.fail(opts.remoteError);
              return Effect.succeed((opts.remote ?? []).map((version) => ({ version })));
            }
            return Effect.succeed([]);
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
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    BunServices.layer,
  );
  return {
    layer,
    out,
    telemetry,
    cache,
    resolverCalls,
  };
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

const flags = (over: Partial<LegacyMigrationListFlags> = {}): LegacyMigrationListFlags => ({
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? true,
  local: over.local ?? false,
  password: over.password ?? Option.none(),
});

const seedMigrations = (workdir: string, names: ReadonlyArray<string>) => {
  const dir = join(workdir, "supabase", "migrations");
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, name), "select 1;\n");
};

const tmp = useLegacyTempWorkdir();

describe("legacy migration list", () => {
  it.live("lists merged local + remote migrations for the linked project by default", () => {
    seedMigrations(tmp.current, ["20240101000000_a.sql", "20240103000000_c.sql"]);
    const ctx = setup(tmp.current, {
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationList(flags());
      // Go prints the connection banner to stderr before dialing (connect.go:343-348).
      expect(stripAnsi(ctx.out.stderrText)).toContain("Connecting to remote database...");
      const stdout = stripAnsi(ctx.out.stdoutText);
      expect(stdout).toContain("Local");
      expect(stdout).toContain("Time (UTC)");
      expect(stdout).toContain("`20240101000000`"); // in sync (both)
      expect(stdout).toContain("`20240102000000`"); // remote only
      expect(stdout).toContain("`20240103000000`"); // local only
      // linked by default → resolver receives connType "linked" + cache written.
      expect(ctx.resolverCalls[0]?.connType).toBe("linked");
      expect(ctx.cache.cachedRef).toBe(LEGACY_VALID_REF);
    }).pipe(Effect.provide(ctx.layer));
  });

  it.live("shows an empty Remote column when the history table is absent (42P01)", () => {
    seedMigrations(tmp.current, ["20240101000000_a.sql"]);
    const { layer, out } = setup(tmp.current, {
      remoteError: new LegacyDbExecError({
        message: 'relation "supabase_migrations.schema_migrations" does not exist',
        code: "42P01",
      }),
    });
    return Effect.gen(function* () {
      yield* legacyMigrationList(flags());
      const stdout = stripAnsi(out.stdoutText);
      expect(stdout).toContain("`20240101000000`");
      expect(stdout).toContain("` `"); // empty Remote cell
    }).pipe(Effect.provide(layer));
  });

  it.live("skips init-schema and non-migration files when loading local versions", () => {
    seedMigrations(tmp.current, [
      "20211208000000_init.sql", // pre-cutoff init → skipped
      "not-a-migration.txt", // non-matching → skipped
      "20240105000000_keep.sql",
    ]);
    const { layer, out } = setup(tmp.current, { remote: [] });
    return Effect.gen(function* () {
      yield* legacyMigrationList(flags());
      const stdout = stripAnsi(out.stdoutText);
      expect(stdout).toContain("`20240105000000`");
      expect(stdout).not.toContain("20211208000000");
    }).pipe(Effect.provide(layer));
  });

  it.live("targets the local database with --local and skips the linked cache", () => {
    seedMigrations(tmp.current, ["20240101000000_a.sql"]);
    const ctx = setup(tmp.current, {
      args: ["--local"],
      isLocal: true,
      remote: [],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationList(flags({ linked: false, local: true }));
      expect(ctx.resolverCalls[0]?.connType).toBe("local");
      expect(ctx.cache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(ctx.layer));
  });

  it.live("rejects --db-url combined with --linked", () => {
    const { layer } = setup(tmp.current, { args: ["--db-url", "postgresql://x", "--linked"] });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationList(
        flags({ dbUrl: Option.some("postgresql://x"), linked: true }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe(
          "LegacyMigrationTargetFlagsError",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --db-url combined with --password", () => {
    const { layer } = setup(tmp.current, { args: ["--db-url", "postgresql://x"] });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationList(
        flags({ dbUrl: Option.some("postgresql://x"), password: Option.some("pw") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe(
          "LegacyMigrationPasswordFlagsError",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits structured migrations in json", () => {
    seedMigrations(tmp.current, ["20240103000000_c.sql"]);
    const { layer, out } = setup(tmp.current, { format: "json", remote: ["20240102000000"] });
    return Effect.gen(function* () {
      yield* legacyMigrationList(flags());
      expect(out.stdoutText).toBe(""); // no glamour table on stdout in json mode
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migrations listed",
          data: {
            migrations: [
              { local: "", remote: "20240102000000", time: "2024-01-02 00:00:00" },
              { local: "20240103000000", remote: "", time: "2024-01-03 00:00:00" },
            ],
          },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("propagates a non-undefined-table remote read failure", () => {
    seedMigrations(tmp.current, ["20240101000000_a.sql"]);
    const { layer } = setup(tmp.current, {
      remoteError: new LegacyDbExecError({
        message: "permission denied for schema",
        code: "42501",
      }),
    });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationList(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value instanceof LegacyMigrationsReadError).toBe(
          true,
        );
      }
    }).pipe(Effect.provide(layer));
  });
});
