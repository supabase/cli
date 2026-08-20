import { describe, expect, it } from "@effect/vitest";
import { classifyPlanHazards, type Plan } from "@supabase/pg-delta/plan";
import { Effect, Exit, Layer, Option } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import type { DatabaseTarget } from "../database/database-target.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { SchemaLocalStackNotRunningError } from "../schema/schema-errors.ts";
import { SchemaStateStore } from "../schema/schema-state.service.ts";
import type { SchemaDraftJournal, SchemaPlanView } from "../schema/schema-types.ts";
import { SchemaWorkspace } from "../schema/schema-workspace.service.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";
import { pushMigrations } from "./push-migrations.ts";

const linked = {
  kind: "linked" as const,
  identity: "abcdefghijklmnop",
  connectionString: "postgresql://postgres:secret@db.example/postgres",
  disposable: false,
  durable: true,
  connectionVerified: false,
  projectRef: "abcdefghijklmnop",
};

function emptyPlan(): Plan {
  return {
    formatVersion: 1,
    engineVersion: "0.3.0",
    planId: "plan",
    source: { fingerprint: "s" },
    target: { fingerprint: "d" },
    preamble: [],
    deltas: [],
    filteredDeltas: [],
    renameCandidates: [],
    actions: [],
    safetyReport: {
      destructiveActions: 0,
      rewriteRiskActions: 0,
      nonTransactionalActions: 0,
      lockClasses: {},
    },
  };
}

function planView(changes: boolean): SchemaPlanView {
  const plan = emptyPlan();
  return {
    planId: plan.planId,
    sourceFingerprint: plan.source.fingerprint,
    desiredFingerprint: plan.target.fingerprint,
    engineVersion: plan.engineVersion,
    profile: "supabase",
    changes,
    files: [],
    hazards: {
      kinds: [],
      destructive: 0,
      rewrite: 0,
      coverageGaps: 0,
      report: classifyPlanHazards(plan),
    },
    destructive: false,
    renameCandidates: [],
    acceptedRenames: [],
    coverageBlocked: false,
    renameBlocked: false,
    diagnostics: [],
    plan,
  };
}

const ungeneratedJournal: SchemaDraftJournal = {
  version: 1,
  draftId: "draft",
  targetIdentity: "local:default",
  startingMigrationHeadDigest: "abc",
  sourceFingerprint: "s",
  engineVersion: "0.3.0",
  declarativelyAhead: true,
  generated: false,
  plans: [],
};

const pendingFile = {
  version: "20260101000000",
  name: "init",
  fileName: "20260101000000_init.sql",
  absolutePath: "/tmp/migrations/20260101000000_init.sql",
  content: "select 1;",
  transactional: true,
};

function setup(
  opts: {
    declarations?: boolean;
    ahead?: boolean;
    localRunning?: boolean;
    drift?: boolean;
    driftResults?: ReadonlyArray<boolean>;
    journal?: SchemaDraftJournal;
    files?: ReadonlyArray<typeof pendingFile>;
    history?: ReadonlyArray<{ version: string; name: string }>;
    target?: DatabaseTarget;
  } = {},
) {
  const out = mockOutput({ interactive: false });
  let shadowProvisions = 0;
  let platformProvisions = 0;
  let appliedVersions: ReadonlyArray<string> = [];
  let diffCalls = 0;
  const layer = Layer.mergeAll(
    out.layer,
    Layer.succeed(
      SchemaWorkspace,
      SchemaWorkspace.of({
        schemasDir: "/tmp/schemas",
        schemasDirDisplay: "supabase/schemas",
        migrationsDir: "/tmp/migrations",
        migrationsDirDisplay: "supabase/migrations",
        customDir: "/tmp/schemas/_custom",
        journalPath: "/tmp/.supabase/schema-draft.json",
        lockPath: "/tmp/.supabase/schema.lock",
        readDeclarationFiles: Effect.succeed(
          opts.declarations === false ? [] : [{ name: "a.sql", sql: "create table a (id int);" }],
        ),
        readExistingSql: () => Effect.succeed(new Map()),
        classifyProposed: () => Effect.die("unused"),
        installExport: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      SchemaStateStore,
      SchemaStateStore.of({
        readJournal: Effect.succeed(
          opts.journal === undefined ? Option.none() : Option.some(opts.journal),
        ),
        writeJournal: () => Effect.void,
        clearJournal: Effect.void,
        withLock: (effect) => effect,
      }),
    ),
    Layer.succeed(
      DatabaseTargetResolver,
      DatabaseTargetResolver.of({
        resolve: (selector) => {
          if (selector.kind === "local" && opts.localRunning === false) {
            return Effect.fail(
              new SchemaLocalStackNotRunningError({
                detail: "No local Supabase stack is running for this project.",
                suggestion: "Run `supabase start`, then retry.",
              }),
            );
          }
          return Effect.succeed(opts.target ?? linked);
        },
      }),
    ),
    Layer.succeed(
      MigrationRepository,
      MigrationRepository.of({
        listLocal: Effect.succeed(opts.files ?? []),
        createEmpty: () => Effect.die("unused"),
        writeGenerated: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      MigrationRunner,
      MigrationRunner.of({
        listRemote: () => Effect.succeed(opts.history ?? []),
        applyPending: (_pool, files) =>
          Effect.sync(() => {
            appliedVersions = files.map((file) => file.version);
            return { applied: [], skipped: [] };
          }),
        markApplied: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      PgDeltaSchemaEngine,
      PgDeltaSchemaEngine.of({
        exportSchema: () => Effect.die("unused"),
        planFiles: () => Effect.succeed(planView(opts.ahead === true)),
        diffPools: () => {
          const changes =
            opts.driftResults !== undefined
              ? opts.driftResults[diffCalls] === true
              : opts.drift === true;
          diffCalls += 1;
          return Effect.succeed(planView(changes));
        },
        applyPlan: () => Effect.die("unused"),
        provisionShadow: Effect.sync(() => {
          shadowProvisions += 1;
          return { url: "postgresql://postgres:postgres@127.0.0.1:1/postgres" };
        }),
        provisionPlatform: Effect.sync(() => {
          platformProvisions += 1;
          return { url: "postgresql://postgres:postgres@127.0.0.1:1/postgres" };
        }),
        provisionMigrations: Effect.sync(() => {
          shadowProvisions += 1;
          return { url: "postgresql://postgres:postgres@127.0.0.1:1/postgres" };
        }),
      }),
    ),
  );
  return {
    layer,
    get shadowProvisions() {
      return shadowProvisions;
    },
    get platformProvisions() {
      return platformProvisions;
    },
    get appliedVersions() {
      return appliedVersions;
    },
  };
}

const pushFlags = {
  yes: true,
  allowRemote: false,
  projectRef: "abcdefghijklmnop",
  skipVerify: false,
} as const;

describe("pushMigrations", () => {
  it.live("fails closed when an ungenerated draft is active", () => {
    const { layer } = setup({ journal: ungeneratedJournal });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("fails closed when live M to D still has changes", () => {
    const { layer } = setup({ declarations: true, ahead: true });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("checks remote drift even when no local stack is running", () => {
    const ctx = setup({
      declarations: false,
      localRunning: false,
      drift: true,
      files: [pendingFile],
      history: [{ version: pendingFile.version, name: pendingFile.name }],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("supabase migrations pull --from linked");
      expect(ctx.shadowProvisions).toBe(0);
      expect(ctx.platformProvisions).toBe(1);
      expect(ctx.appliedVersions).toEqual([pendingFile.version]);
    });
  });

  it.live("suggests migration repair when a pending prefix already matches the remote", () => {
    const { layer } = setup({
      declarations: false,
      driftResults: [true, false],
      files: [pendingFile],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "supabase migration repair --project-ref abcdefghijklmnop --status applied 20260101000000",
      );
    });
  });

  it.live("suggests reverted repair for remote-only versions", () => {
    const { layer } = setup({
      declarations: false,
      driftResults: [true, true],
      files: [pendingFile],
      history: [{ version: "19990101000000", name: "other" }],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "supabase migration repair --project-ref abcdefghijklmnop --status reverted 19990101000000",
      );
      expect(JSON.stringify(exit)).toContain("supabase migrations pull --from linked");
    });
  });

  it.live("pushes when replay matches declarations and the remote", () => {
    const ctx = setup({
      declarations: true,
      ahead: false,
      localRunning: false,
      drift: false,
    });
    return Effect.gen(function* () {
      const result = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(false);
      expect(ctx.shadowProvisions).toBe(2);
      expect(ctx.platformProvisions).toBe(1);
    });
  });

  it.live("still refuses an ungenerated draft when --skip-verify is set", () => {
    const { layer } = setup({ journal: ungeneratedJournal });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations({ ...pushFlags, skipVerify: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("prefills target-aware repair when skip-verify hits remote-only history", () => {
    const { layer } = setup({
      files: [pendingFile],
      history: [{ version: "19990101000000", name: "other" }],
      target: {
        kind: "url",
        identity: "connection-string",
        connectionString: "postgresql://postgres:secret@db.example/postgres",
        disposable: false,
        durable: true,
        connectionVerified: false,
        connectionSource: "flag",
      },
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations({
        yes: true,
        allowRemote: true,
        skipVerify: true,
        dbUrl: "postgresql://postgres:secret@db.example/postgres",
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "supabase migration repair --db-url <same-url> --status reverted 19990101000000",
      );
    });
  });

  it.live("skips shadow verify when --skip-verify is set", () => {
    const ctx = setup({
      declarations: true,
      ahead: true,
      drift: true,
    });
    return Effect.gen(function* () {
      const result = yield* pushMigrations({ ...pushFlags, skipVerify: true }).pipe(
        Effect.provide(ctx.layer),
      );
      expect(result.mutatedDatabase).toBe(false);
      expect(ctx.shadowProvisions).toBe(0);
      expect(ctx.platformProvisions).toBe(0);
    });
  });
});
