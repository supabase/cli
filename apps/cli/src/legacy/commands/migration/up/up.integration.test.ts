import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { stripAnsi } from "../../../../../tests/helpers/ansi.ts";
import {
  LEGACY_VALID_REF,
  mockLegacyCliSettings,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
  legacySequentialExecBatch,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import {
  type LegacyDbSession,
  LegacyDbConnection,
} from "../../../shared/legacy-db-connection.service.ts";
import { LegacyMigrationVaultError } from "../../../shared/legacy-vault.ts";
import { legacyMigrationUp } from "./up.handler.ts";
import type { LegacyMigrationUpFlags } from "./up.command.ts";

const LIST_SQL = "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";
const READ_VAULT = "SELECT id, name FROM vault.secrets WHERE name = ANY($1)";

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly args?: ReadonlyArray<string>;
  readonly remote?: ReadonlyArray<string>;
  readonly failApply?: boolean;
  readonly failVault?: boolean;
  readonly config?: string;
  readonly existingVault?: ReadonlyArray<{ id: string; name: string }>;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  if (opts.config !== undefined) {
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), opts.config);
  }
  const out = mockOutput({ format: opts.format ?? "text" });
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
    connect: () => {
      const session: LegacyDbSession = {
        exec: (sql: string) =>
          Effect.suspend(() => {
            execs.push(sql);
            return opts.failApply === true && sql.startsWith("create table boom")
              ? Effect.fail(new LegacyDbExecError({ message: "syntax error" }))
              : Effect.void;
          }),
        query: (sql: string, params?: ReadonlyArray<unknown>) =>
          Effect.suspend(() => {
            queries.push({ sql, params });
            if (opts.failVault === true && sql === READ_VAULT)
              return Effect.fail(new LegacyDbExecError({ message: "boom" }));
            if (sql === LIST_SQL)
              return Effect.succeed((opts.remote ?? []).map((version) => ({ version })));
            if (sql === READ_VAULT)
              return Effect.succeed<ReadonlyArray<Record<string, unknown>>>([
                ...(opts.existingVault ?? []),
              ]);
            return Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
          }),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        // A migration file's statements arrive as one batch; replay them through
        // `exec`/`query` so this suite's recordings and failure injection still apply.
        execBatch: (statements) => legacySequentialExecBatch(session)(statements),
      };
      return Effect.succeed(session);
    },
  });

  // `loadProjectRef` gives an explicit `--project-ref` flag top precedence, same
  // as Go's `flags.LoadProjectRef` — mirror that so a test can prove the flag
  // (not just the hardcoded `LEGACY_VALID_REF` fallback) drives the linked ref.
  const projectRef = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(LEGACY_VALID_REF),
    resolveForLink: () => Effect.succeed(LEGACY_VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(LEGACY_VALID_REF)),
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Effect.succeed(
        Option.isSome(flagValue) && flagValue.value.length > 0 ? flagValue.value : LEGACY_VALID_REF,
      ),
    promptProjectRef: () => Effect.succeed(LEGACY_VALID_REF),
  });

  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    resolver,
    connection,
    projectRef,
    mockLegacyCliSettings({ workdir }),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    BunServices.layer,
  );
  return { layer, out, telemetry, execs, queries, cache };
}

const flags = (over: Partial<LegacyMigrationUpFlags> = {}): LegacyMigrationUpFlags => ({
  includeAll: over.includeAll ?? false,
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? true,
  projectRef: over.projectRef ?? Option.none(),
});

const seed = (workdir: string, name: string, body = "create table a;\n") => {
  const dir = join(workdir, "supabase", "migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
};
const insertedVersions = (queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }>) =>
  queries
    .filter((q) => q.sql.includes("INSERT INTO supabase_migrations"))
    .map((q) => q.params?.[0]);

const tmp = useLegacyTempWorkdir();

describe("legacy migration up", () => {
  it.live("applies pending migrations in order and prints progress", () => {
    seed(tmp.current, "20240101000000_a.sql");
    seed(tmp.current, "20240102000000_b.sql");
    seed(tmp.current, "20240103000000_c.sql");
    const { layer, out, queries } = setup(tmp.current, { remote: ["20240101000000"] });
    return Effect.gen(function* () {
      yield* legacyMigrationUp(flags());
      const stderr = stripAnsi(out.stderrText);
      const stdout = stripAnsi(out.stdoutText);
      // The connection banner prints to stderr before dialing.
      expect(stderr).toContain("Connecting to local database...");
      expect(stderr).toContain("Applying migration 20240102000000_b.sql...");
      expect(stderr).toContain("Applying migration 20240103000000_c.sql...");
      expect(stdout).toContain("Local database is up to date.");
      // Lock the channel split: "Applying ..." is stderr
      // and the final "up to date" is stdout — neither bleeds across.
      expect(stdout).not.toContain("Applying migration");
      expect(stderr).not.toContain("Local database is up to date.");
      expect(insertedVersions(queries)).toEqual(["20240102000000", "20240103000000"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("errors with a revert suggestion when a remote version is missing locally", () => {
    seed(tmp.current, "20240101000000_a.sql");
    const { layer } = setup(tmp.current, { remote: ["20240101000000", "20240199000000"] });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationUp(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe(
          "LegacyMigrationMissingLocalError",
        );
        expect(JSON.stringify(exit.cause)).toContain("migration repair --local --status reverted");
        expect(JSON.stringify(exit.cause)).toContain("supabase db pull --local");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("errors with an --include-all suggestion on an out-of-order local migration", () => {
    seed(tmp.current, "20240101000000_a.sql");
    seed(tmp.current, "20240102000000_b.sql");
    const { layer } = setup(tmp.current, { remote: ["20240102000000"] });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationUp(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe(
          "LegacyMigrationMissingRemoteError",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("applies out-of-order migrations with --include-all in the right order", () => {
    seed(tmp.current, "20240101000000_a.sql"); // out-of-order (before applied 02)
    seed(tmp.current, "20240102000000_b.sql"); // already applied on remote
    seed(tmp.current, "20240103000000_c.sql"); // trailing pending
    const { layer, queries } = setup(tmp.current, { remote: ["20240102000000"] });
    return Effect.gen(function* () {
      yield* legacyMigrationUp(flags({ includeAll: true }));
      // The trailing pending set is appended after the out-of-order set.
      expect(insertedVersions(queries)).toEqual(["20240101000000", "20240103000000"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("creates a new [db.vault] secret before applying migrations", () => {
    seed(tmp.current, "20240101000000_a.sql");
    const { layer, out, queries } = setup(tmp.current, {
      remote: [],
      config: '[db.vault]\nmy_secret = "shhh"\n',
    });
    return Effect.gen(function* () {
      yield* legacyMigrationUp(flags());
      expect(stripAnsi(out.stderrText)).toContain("Updating vault secrets...");
      const create = queries.find((q) => q.sql.includes("create_secret"));
      expect(create?.params).toEqual(["shhh", "my_secret"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a vault upsert failure", () => {
    seed(tmp.current, "20240101000000_a.sql");
    const { layer } = setup(tmp.current, {
      remote: [],
      config: '[db.vault]\nmy_secret = "shhh"\n',
      failVault: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationUp(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value instanceof LegacyMigrationVaultError).toBe(
          true,
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("updates an existing [db.vault] secret by id", () => {
    seed(tmp.current, "20240101000000_a.sql");
    const { layer, queries } = setup(tmp.current, {
      remote: [],
      config: '[db.vault]\nmy_secret = "shhh"\n',
      existingVault: [{ id: "vault-id-1", name: "my_secret" }],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationUp(flags());
      const update = queries.find((q) => q.sql.includes("update_secret"));
      expect(update?.params).toEqual(["vault-id-1", "shhh"]);
      expect(queries.some((q) => q.sql.includes("create_secret"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --db-url combined with --linked", () => {
    const { layer } = setup(tmp.current, { args: ["--db-url", "postgresql://x", "--linked"] });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationUp(
        flags({ dbUrl: Option.some("postgresql://x"), linked: true, local: false }),
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

  it.live(
    "applies on the project given via --project-ref --linked, overriding the linked ref",
    () => {
      // up defaults to local; only with --linked does the flag's ref get cached.
      // The fake resolver's own fallback (LEGACY_VALID_REF) represents whatever
      // the workdir would resolve to absent the flag — the flag must win over it.
      const FLAG_REF = "flagflagflagflagflag";
      const { layer, cache } = setup(tmp.current, { args: ["--linked"], remote: [] });
      return Effect.gen(function* () {
        yield* legacyMigrationUp(
          flags({ linked: true, local: false, projectRef: Option.some(FLAG_REF) }),
        );
        expect(cache.cached).toBe(true);
        expect(cache.cachedRef).toBe(FLAG_REF);
        expect(cache.cachedRef).not.toBe(LEGACY_VALID_REF);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("rejects --project-ref on the default local target", () => {
    // up defaults to local when no target flag is set — the guard must fire
    // from the flag alone, with no explicit --local/--db-url needed.
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, execs, queries, cache } = setup(tmp.current, { remote: [] });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationUp(flags({ projectRef: Option.some(FLAG_REF) })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe(
          "LegacyMigrationTargetFlagsError",
        );
        expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        );
      }
      expect(execs).toEqual([]);
      expect(queries).toEqual([]);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured result in json", () => {
    seed(tmp.current, "20240101000000_a.sql");
    const { layer, out } = setup(tmp.current, { format: "json", remote: [] });
    return Effect.gen(function* () {
      yield* legacyMigrationUp(flags());
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Migrations applied" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces an apply failure", () => {
    seed(tmp.current, "20240101000000_a.sql", "create table boom;\n");
    const { layer } = setup(tmp.current, { remote: [], failApply: true });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationUp(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyMigrationApplyError");
      }
    }).pipe(Effect.provide(layer));
  });
});
