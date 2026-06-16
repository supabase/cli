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
  LegacyYesFlag,
} from "../../../../../../shared/legacy/global-flags.ts";
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
  promptTextResponses?: ReadonlyArray<string>;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    promptConfirmResponses: opts.promptConfirmResponses,
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
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    seam,
    edge,
    dbConn,
    mockLegacyCliConfig({ workdir, projectId: Option.some("test") }),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? true),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
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
});
