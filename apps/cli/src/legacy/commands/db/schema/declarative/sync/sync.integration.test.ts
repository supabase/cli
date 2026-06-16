import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { mockOutput, mockTty } from "../../../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../../../tests/helpers/legacy-mocks.ts";
import {
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
} from "../../../../../../shared/legacy/global-flags.ts";
import { LegacyDbConfigResolver } from "../../../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../../../shared/legacy-db-connection.service.ts";
import {
  type LegacyEdgeRuntimeRunOpts,
  LegacyEdgeRuntimeScript,
} from "../../../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyDeclarativeSeam } from "../declarative.seam.service.ts";
import type { LegacyDbSchemaDeclarativeSyncFlags } from "./sync.command.ts";
import { legacyDbSchemaDeclarativeSync } from "./sync.handler.ts";

interface SetupOpts {
  experimental?: boolean;
  yes?: boolean;
  stdinIsTty?: boolean;
  diffSql?: string;
  applyFails?: boolean;
  resetExitCode?: number;
  promptConfirmResponses?: ReadonlyArray<boolean>;
  promptSelectResponses?: ReadonlyArray<string>;
  promptTextResponses?: ReadonlyArray<string>;
  networkId?: string;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    promptConfirmResponses: opts.promptConfirmResponses,
    promptSelectResponses: opts.promptSelectResponses,
    promptTextResponses: opts.promptTextResponses,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const execInheritCalls: ReadonlyArray<string>[] = [];
  const seam = Layer.succeed(LegacyDeclarativeSeam, {
    exportCatalog: ({ mode }) => Effect.succeed(`supabase/.temp/pgdelta/${mode}.json`),
    execInherit: (args) =>
      Effect.sync(() => {
        execInheritCalls.push(args);
        return opts.resetExitCode ?? 0;
      }),
    ensureLocalDatabaseStarted: () => Effect.void,
  });
  const edge = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (_opts: LegacyEdgeRuntimeRunOpts) =>
      Effect.succeed({ stdout: opts.diffSql ?? "", stderr: "" }),
  });
  const dbExec: string[] = [];
  const dbConn = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
        exec: (sql: string) =>
          opts.applyFails === true && sql.startsWith("ALTER")
            ? Effect.fail({ _tag: "LegacyDbExecError", message: "boom" } as never)
            : Effect.sync(() => {
                dbExec.push(sql);
              }),
        query: (sql: string) =>
          Effect.sync(() => {
            dbExec.push(sql);
            return [];
          }),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
      }),
  });
  // The no-files bootstrap delegates to the shared smart-target resolver; its
  // local path never calls `resolve`, but the linked/custom branches would.
  const resolver = Layer.succeed(LegacyDbConfigResolver, {
    resolve: () =>
      Effect.succeed({
        conn: {
          host: "db.remote",
          port: 5432,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: false,
      }),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    seam,
    edge,
    dbConn,
    resolver,
    mockLegacyCliConfig({ workdir, projectId: Option.some("test") }),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? true),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(
      LegacyNetworkIdFlag,
      opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
    ),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    BunServices.layer,
  );
  return { layer, out, execInheritCalls, dbExec };
}

const flags = (
  over: Partial<LegacyDbSchemaDeclarativeSyncFlags> = {},
): LegacyDbSchemaDeclarativeSyncFlags => ({
  noCache: over.noCache ?? false,
  schema: over.schema ?? [],
  file: over.file ?? Option.none(),
  name: over.name ?? Option.none(),
  apply: over.apply ?? false,
  noApply: over.noApply ?? false,
});

const failError = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

const seedDeclarative = (workdir: string) => {
  const dir = join(workdir, "supabase", "database");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "public.sql"), "create table a();");
};

describe("legacy db schema declarative sync integration", () => {
  const tmp = useLegacyTempWorkdir();

  it.effect("gate: fails when pg-delta is not enabled", () => {
    seedDeclarative(tmp.current);
    const { layer } = setup(tmp.current, { experimental: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeSync(flags()));
      expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeNotEnabledError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --apply and --no-apply together before the pg-delta gate", () => {
    // cobra MarkFlagsMutuallyExclusive("apply", "no-apply") runs before PreRunE,
    // so this fails even when pg-delta is not enabled.
    const { layer } = setup(tmp.current, { experimental: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeSync(flags({ apply: true, noApply: true })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeMutuallyExclusiveFlagsError",
        message:
          "if any flags in the group [apply no-apply] are set none of the others can be; [apply no-apply] were all set",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when there are no declarative files", () => {
    const { layer } = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeSync(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect((failError(exit) as { message: string }).message).toContain(
        "no declarative schema found",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("--yes bypasses the bootstrap prompt when no declarative files exist", () => {
    // Without --yes + non-TTY this fails at the "no declarative schema found" gate
    // (prior test). With --yes, Go's PromptYesNo auto-confirms, so the bootstrap is
    // attempted instead — it must NOT fail at that gate. No promptConfirm is queued,
    // so reaching the prompt would also error.
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false, yes: true, diffSql: "" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeSync(flags({ noApply: true })));
      expect(JSON.stringify(exit)).not.toContain("no declarative schema found");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap with migrations offers the smart target choice (not local-only)", () => {
    // Go delegates the no-files bootstrap to runDeclarativeGenerate; with migrations
    // present it offers local/linked/custom rather than silently generating from
    // local. projectId "test" is an invalid ref so the linked choice is hidden.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      diffSql: "",
      promptConfirmResponses: [true, false], // [generate a new one? yes][reset? no]
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyDbSchemaDeclarativeSync(flags({ noApply: true })));
      const options = s.out.promptSelectCalls[0]?.options ?? [];
      expect(options.map((o) => o.value)).toEqual(["local", "custom"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("empty diff prints 'No schema changes found' and writes nothing", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, { experimental: true, diffSql: "" });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: true }));
      expect(s.out.rawChunks.some((c) => c.text.includes("No schema changes found"))).toBe(true);
      expect(existsSync(join(tmp.current, "supabase", "migrations"))).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "--no-apply: writes the timestamped migration, surfaces drop warnings, no apply",
    () => {
      seedDeclarative(tmp.current);
      const s = setup(tmp.current, {
        experimental: true,
        diffSql: "ALTER TABLE a ADD COLUMN b int;\nDROP TABLE c;\n",
      });
      return Effect.gen(function* () {
        yield* legacyDbSchemaDeclarativeSync(flags({ noApply: true }));
        const migrations = readdirSync(join(tmp.current, "supabase", "migrations"));
        expect(migrations).toHaveLength(1);
        expect(migrations[0]).toMatch(/^\d{14}_declarative_sync\.sql$/);
        expect(s.out.rawChunks.some((c) => c.text.includes("Found drop statements"))).toBe(true);
        expect(s.dbExec).toEqual([]); // not applied
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "--apply: applies the migration natively (BEGIN … statements … COMMIT + history)",
    () => {
      seedDeclarative(tmp.current);
      const s = setup(tmp.current, {
        experimental: true,
        diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
      });
      return Effect.gen(function* () {
        yield* legacyDbSchemaDeclarativeSync(flags({ apply: true }));
        expect(s.dbExec).toContain("BEGIN");
        expect(s.dbExec).toContain("ALTER TABLE a ADD COLUMN b int");
        expect(s.dbExec).toContain("COMMIT");
        expect(s.dbExec.some((q) => q.includes("supabase_migrations.schema_migrations"))).toBe(
          true,
        );
        expect(s.execInheritCalls).toEqual([]); // no reset on success
        expect(s.out.rawChunks.some((c) => c.text.includes("Migration applied successfully"))).toBe(
          true,
        );
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("--name overrides the migration filename stem", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      experimental: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: true, name: Option.some("add_b") }));
      const migrations = readdirSync(join(tmp.current, "supabase", "migrations"));
      expect(migrations[0]).toMatch(/^\d{14}_add_b\.sql$/);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "apply failure in a TTY offers reset+reapply and delegates reset to the Go binary",
    () => {
      seedDeclarative(tmp.current);
      const s = setup(tmp.current, {
        experimental: true,
        diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
        applyFails: true,
        stdinIsTty: true,
        promptConfirmResponses: [true], // accept the reset offer
        resetExitCode: 0,
      });
      return Effect.gen(function* () {
        yield* legacyDbSchemaDeclarativeSync(flags({ apply: true }));
        expect(s.out.rawChunks.some((c) => c.text.includes("Migration failed to apply"))).toBe(
          true,
        );
        expect(s.execInheritCalls).toEqual([["db", "reset", "--local"]]);
        expect(
          s.out.rawChunks.some((c) =>
            c.text.includes("Database reset and all migrations applied successfully"),
          ),
        ).toBe(true);
        expect(existsSync(join(tmp.current, "supabase", ".temp", "pgdelta", "debug"))).toBe(true);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("surfaces the reset failure (not the apply error) when reset also fails", () => {
    // Go returns resetErr here (`cmd/db_schema_declarative.go:414-423`), so the failure
    // that actually blocked recovery is reported, not the original apply error ("boom").
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      experimental: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
      applyFails: true,
      stdinIsTty: true,
      promptConfirmResponses: [true], // accept the reset offer
      resetExitCode: 1, // …and the reset itself fails
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeSync(flags({ apply: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({ message: "database reset failed (exit 1)" });
      expect(
        s.out.rawChunks.some((c) =>
          c.text.includes("Database reset also failed: database reset failed (exit 1)"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("forwards --network-id to the recovery reset", () => {
    // Go's in-process reset.Run honors the root viper network-id, so the
    // seam-spawned reset must carry --network-id to stay on a custom network.
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      experimental: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
      applyFails: true,
      stdinIsTty: true,
      promptConfirmResponses: [true], // accept the reset offer
      resetExitCode: 0,
      networkId: "my_net",
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ apply: true }));
      expect(s.execInheritCalls).toContainEqual([
        "db",
        "reset",
        "--local",
        "--network-id",
        "my_net",
      ]);
    }).pipe(Effect.provide(s.layer));
  });
});
