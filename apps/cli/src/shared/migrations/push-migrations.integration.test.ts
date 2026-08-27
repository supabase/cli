import { describe, expect, it } from "@effect/vitest";
import { classifyPlanHazards, type Plan } from "@supabase/pg-delta/plan";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import type { DatabaseTarget } from "../database/database-target.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import {
  SchemaCancelledError,
  SchemaCatalogAdoptError,
  SchemaDeclarationsAheadError,
  SchemaDestructiveAuthError,
  SchemaEmptyMigrationStatementsError,
  SchemaEngineError,
  SchemaLocalStackNotRunningError,
  SchemaAllowRemoteRequiredError,
  SchemaHistoryConflictError,
  SchemaPrivilegeOfferError,
  SchemaRemoteDriftError,
} from "../schema/schema-errors.ts";
import { SchemaStateStore } from "../schema/schema-state.service.ts";
import type { SchemaDraftJournal, SchemaPlanView } from "../schema/schema-types.ts";
import { SchemaWorkspace } from "../schema/schema-workspace.service.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import { formatHistoryConflict } from "./migration-repair-suggest.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";
import { REVOKE_API_PRIVILEGES_SQL } from "./privilege-offer.ts";
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

const ACL_SQL = `
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT ON TABLES TO "anon";
`;

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

function planView(changes: boolean, sql = ""): SchemaPlanView {
  const plan = emptyPlan();
  return {
    planId: plan.planId,
    sourceFingerprint: plan.source.fingerprint,
    desiredFingerprint: plan.target.fingerprint,
    engineVersion: plan.engineVersion,
    profile: "supabase",
    changes,
    files:
      changes && sql.length > 0
        ? [
            {
              sequence: 1,
              suffix: null,
              sql,
              transactional: true,
              actionCount: 1,
            },
          ]
        : [],
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

const revokeFile = {
  version: "20260102000000",
  name: "revoke_api_privileges",
  fileName: "20260102000000_revoke_api_privileges.sql",
  absolutePath: "/tmp/migrations/20260102000000_revoke_api_privileges.sql",
  content: REVOKE_API_PRIVILEGES_SQL,
  transactional: true,
};

function setup(
  opts: {
    declarations?: boolean;
    ahead?: boolean;
    localRunning?: boolean;
    drift?: boolean;
    driftResults?: ReadonlyArray<boolean>;
    driftSql?: string;
    journal?: SchemaDraftJournal;
    aheadSql?: string;
    applyFailPending?: boolean;
    files?: ReadonlyArray<typeof pendingFile>;
    history?: ReadonlyArray<{ version: string; name: string }>;
    localHistory?: ReadonlyArray<{ version: string; name: string }>;
    localHistoryFail?: boolean;
    target?: DatabaseTarget;
    interactive?: boolean;
    confirm?: boolean;
    promptTextResponses?: ReadonlyArray<string>;
  } = {},
) {
  const out = mockOutput({
    interactive: opts.interactive ?? false,
    ...(opts.confirm !== undefined ? { promptConfirmResponses: [opts.confirm] } : {}),
    ...(opts.promptTextResponses !== undefined
      ? { promptTextResponses: opts.promptTextResponses }
      : {}),
  });
  let shadowProvisions = 0;
  let platformProvisions = 0;
  let appliedVersions: ReadonlyArray<string> = [];
  let applyCalls = 0;
  let remoteApplyCalls = 0;
  let diffCalls = 0;
  const remoteUrl = (opts.target ?? linked).connectionString;
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
          if (selector.kind === "local") {
            if (opts.localRunning === false) {
              return Effect.fail(
                new SchemaLocalStackNotRunningError({
                  detail: "No local Supabase stack is running for this project.",
                  suggestion: "Run `supabase start`, then retry.",
                }),
              );
            }
            return Effect.succeed({
              kind: "local" as const,
              identity: "local:default",
              connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
              disposable: true,
              durable: false,
              connectionVerified: true,
            });
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
        writeFetched: () => Effect.die("unused"),
        writeGenerated: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      MigrationRunner,
      MigrationRunner.of({
        listRemote: (pool) => {
          const conn = pool.options.connectionString ?? "";
          if (conn.includes("54322")) {
            if (opts.localHistoryFail === true) {
              return Effect.fail(
                new SchemaEngineError({
                  detail: "local history unavailable",
                  suggestion: "Retry when the local database is reachable.",
                }),
              );
            }
            return Effect.succeed(opts.localHistory ?? []);
          }
          return Effect.succeed(opts.history ?? []);
        },
        listRemoteStatements: () => Effect.succeed([]),
        showServerVersion: () => Effect.succeed(undefined),
        listInstalledExtensions: () => Effect.die("unused"),
        applyPending: (pool, files) =>
          Effect.gen(function* () {
            applyCalls += 1;
            const recorded = new Set((opts.history ?? []).map((row) => row.version));
            const pendingOnly = files.filter((file) => !recorded.has(file.version));
            const remoteOnly = [...recorded].filter(
              (version) => !files.some((file) => file.version === version),
            );
            if (remoteOnly.length > 0 && pendingOnly.length > 0) {
              return yield* new SchemaHistoryConflictError(
                formatHistoryConflict({
                  remoteOnly,
                  pending: pendingOnly.map((file) => file.version),
                }),
              );
            }
            if (opts.applyFailPending === true && pendingOnly.length > 0) {
              return yield* new SchemaEngineError({
                detail:
                  "Failed applying migration: function gen_random_bytes(integer) does not exist",
                suggestion: "Check the database connection and migration SQL, then retry.",
              });
            }
            const conn = pool.options.connectionString ?? "";
            const isRemote = conn.includes("db.example") || conn === remoteUrl;
            if (isRemote) {
              remoteApplyCalls += 1;
              appliedVersions = files.map((file) => file.version);
            }
            return {
              applied: pendingOnly.map((file) => file.version),
              skipped: files
                .filter((file) => (opts.history ?? []).some((row) => row.version === file.version))
                .map((file) => file.version),
            };
          }),
        markApplied: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      PgDeltaSchemaEngine,
      PgDeltaSchemaEngine.of({
        exportSchema: () => Effect.die("unused"),
        planFiles: () => Effect.succeed(planView(opts.ahead === true, opts.aheadSql ?? "")),
        diffPools: () => {
          const changes =
            opts.driftResults !== undefined
              ? opts.driftResults[diffCalls] === true
              : opts.drift === true;
          diffCalls += 1;
          return Effect.succeed(planView(changes, opts.driftSql ?? ""));
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
    out,
    get shadowProvisions() {
      return shadowProvisions;
    },
    get platformProvisions() {
      return platformProvisions;
    },
    get appliedVersions() {
      return appliedVersions;
    },
    get applyCalls() {
      return applyCalls;
    },
    get remoteApplyCalls() {
      return remoteApplyCalls;
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
  it.live("refuses DATABASE_URL before listing history", () => {
    const previous = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = "postgresql://postgres:secret@other.example/postgres";
    const ctx = setup({
      declarations: false,
      files: [pendingFile],
      history: [{ version: "20260826095358", name: "notes" }],
      target: {
        kind: "url",
        identity: "connection-string",
        connectionString: "postgresql://postgres:secret@other.example/postgres",
        disposable: false,
        durable: true,
        connectionVerified: false,
        connectionSource: "env",
      },
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations({
        yes: true,
        allowRemote: false,
        skipVerify: false,
      }).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaAllowRemoteRequiredError);
        expect(JSON.stringify(exit)).toContain("Unset DATABASE_URL");
        expect(JSON.stringify(exit)).not.toContain("migrations pull --from");
      }
      expect(ctx.applyCalls).toBe(0);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["DATABASE_URL"];
          else process.env["DATABASE_URL"] = previous;
        }),
      ),
    );
  });

  it.live("fails closed when an ungenerated draft is active", () => {
    const { layer } = setup({ journal: ungeneratedJournal });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("fails closed when live M to D still has changes", () => {
    const ctx = setup({
      declarations: true,
      ahead: true,
      aheadSql: "CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA extensions;",
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaDeclarationsAheadError);
        expect(JSON.stringify(exit)).toContain("pgjwt");
        expect(JSON.stringify(exit)).toContain("schema generate --name <feature>");
      }
      expect(ctx.out.stdoutText).toContain("CREATE EXTENSION");
      expect(ctx.remoteApplyCalls).toBe(0);
    });
  });

  it.live("privilege-only decls-ahead suggests refresh, not generate", () => {
    const ctx = setup({
      declarations: true,
      ahead: true,
      aheadSql: ACL_SQL,
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaDeclarationsAheadError);
        expect(JSON.stringify(exit)).toContain("schema pull --force");
        expect(JSON.stringify(exit)).toContain("db reset");
        expect(JSON.stringify(exit)).not.toContain("schema generate --name");
      }
      expect(ctx.remoteApplyCalls).toBe(0);
    });
  });

  it.live("refuses catalog gap with diff then repair, not pull", () => {
    const ctx = setup({
      declarations: false,
      localRunning: false,
      drift: true,
      driftSql: "CREATE TABLE extra (id int);",
      files: [pendingFile],
      history: [{ version: pendingFile.version, name: pendingFile.name }],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaRemoteDriftError);
        expect(JSON.stringify(exit)).toContain("supabase migrations diff --against linked --file");
        expect(JSON.stringify(exit)).toContain("migration repair");
        expect(JSON.stringify(exit)).not.toContain("supabase migrations pull");
      }
      expect(ctx.shadowProvisions).toBe(0);
      expect(ctx.platformProvisions).toBe(1);
      expect(ctx.applyCalls).toBe(1);
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Ensuring declarations and migrations match before push.",
        }),
      );
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Declarations and migrations are not in sync.",
        }),
      );
    });
  });

  it.live("first-push matching prefix suggests repair, not apply", () => {
    const ctx = setup({
      declarations: false,
      driftResults: [true, false],
      driftSql: "CREATE TABLE extra (id int);",
      files: [pendingFile],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaRemoteDriftError);
        expect(JSON.stringify(exit)).toContain(
          "supabase migration repair --project-ref abcdefghijklmnop --status applied 20260101000000",
        );
        expect(JSON.stringify(exit)).not.toContain("supabase migrations pull");
        expect(JSON.stringify(exit)).not.toContain("migrations diff --against");
      }
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message:
            "Checking whether pending files already match the remote (shadow probe, not a live apply).",
        }),
      );
    });
  });

  it.live("first-push dirty with --yes prints SQL then applies", () => {
    const ctx = setup({
      declarations: false,
      drift: true,
      driftSql: "CREATE TABLE extra (id int);",
      files: [pendingFile],
    });
    return Effect.gen(function* () {
      const result = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(true);
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "No remote migration history yet. This is the first push.",
        }),
      );
      expect(ctx.out.stdoutText).toContain("CREATE TABLE extra");
      expect(result.data).toEqual(
        expect.objectContaining({
          sql: "CREATE TABLE extra (id int);",
          files: [{ name: pendingFile.fileName, version: pendingFile.version }],
        }),
      );
      expect(JSON.stringify(result)).not.toContain("supabase migrations pull");
    });
  });

  it.live("TTY --yes still types the project ref and skips catalog confirm", () => {
    const ctx = setup({
      declarations: false,
      drift: true,
      driftSql: "CREATE TABLE extra (id int);",
      files: [pendingFile],
      interactive: true,
      promptTextResponses: ["abcdefghijklmnop"],
    });
    return Effect.gen(function* () {
      const result = yield* pushMigrations({
        yes: true,
        allowRemote: false,
        skipVerify: false,
      }).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(true);
      expect(ctx.out.promptConfirmCalls).toEqual([]);
    });
  });

  it.live("TTY --yes still fails when the typed project ref does not match", () => {
    const ctx = setup({
      declarations: false,
      drift: true,
      driftSql: "CREATE TABLE extra (id int);",
      files: [pendingFile],
      interactive: true,
      promptTextResponses: ["wrong-ref"],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations({
        yes: true,
        allowRemote: false,
        skipVerify: false,
      }).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaCancelledError);
      }
      expect(ctx.applyCalls).toBe(0);
    });
  });

  it.live("TTY first-push dirty cancel leaves the remote unchanged", () => {
    const ctx = setup({
      declarations: false,
      drift: true,
      driftSql: "CREATE TABLE extra (id int);",
      files: [pendingFile],
      interactive: true,
      confirm: false,
      promptTextResponses: ["abcdefghijklmnop"],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations({
        yes: false,
        allowRemote: false,
        skipVerify: false,
      }).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaCancelledError);
      }
      expect(ctx.applyCalls).toBe(2);
    });
  });

  it.live("non-interactive dirty first-push without --yes requires confirmation", () => {
    const ctx = setup({
      declarations: false,
      drift: true,
      driftSql: "CREATE TABLE extra (id int);",
      files: [pendingFile],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations({
        yes: false,
        allowRemote: false,
        projectRef: "abcdefghijklmnop",
        skipVerify: false,
      }).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaDestructiveAuthError);
        expect(failure.value.suggestion).toContain("--yes");
      }
      expect(ctx.applyCalls).toBe(2);
    });
  });

  it.live("refuses empty history with no files and a dirty catalog as adopt", () => {
    const ctx = setup({
      declarations: false,
      drift: true,
      driftSql: "CREATE TABLE extra (id int);",
      files: [],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaCatalogAdoptError);
        expect(JSON.stringify(exit)).toContain("supabase migrations diff --against linked --file");
        expect(JSON.stringify(exit)).toContain("migration repair");
        expect(JSON.stringify(exit)).not.toContain("db diff");
        expect(JSON.stringify(exit)).not.toContain("up to date");
      }
      expect(ctx.applyCalls).toBe(1);
    });
  });

  it.live("refuses remote-only versions with migrations pull", () => {
    const { layer } = setup({
      declarations: false,
      files: [pendingFile],
      history: [{ version: "19990101000000", name: "other" }],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("supabase migrations pull --from linked");
      expect(JSON.stringify(exit)).not.toContain("repair --status reverted");
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
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "No pending migrations. History matches files on the linked project.",
        }),
      );
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Ensuring declarations and migrations match before push.",
        }),
      );
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Declarations and migrations are in sync.",
        }),
      );
    });
  });

  it.live("previews pending files before the ref prompt", () => {
    const ctx = setup({
      declarations: false,
      drift: false,
      files: [pendingFile],
      interactive: true,
      promptTextResponses: ["abcdefghijklmnop"],
    });
    return Effect.gen(function* () {
      const result = yield* pushMigrations({
        yes: true,
        allowRemote: false,
        skipVerify: false,
      }).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(true);
      expect(ctx.out.stdoutText).toContain("20260101000000  init");
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "1 pending migration will be applied on the linked project.",
        }),
      );
    });
  });

  it.live("says the remote is in sync before the ref prompt when nothing is pending", () => {
    const ctx = setup({
      declarations: false,
      drift: false,
      interactive: true,
      promptTextResponses: ["abcdefghijklmnop"],
    });
    return Effect.gen(function* () {
      const result = yield* pushMigrations({
        yes: true,
        allowRemote: false,
        skipVerify: false,
      }).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(false);
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "No pending migrations. History matches files on the linked project.",
        }),
      );
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

  it.live("points skip-verify remote-only history at pull", () => {
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
      expect(JSON.stringify(exit)).toContain("supabase migrations pull --from <same-url>");
      expect(JSON.stringify(exit)).not.toContain("repair --status reverted");
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

  it.live("offers keep-on vs turn-off for ACL-only first push", () => {
    const ctx = setup({
      declarations: false,
      drift: true,
      driftSql: ACL_SQL,
      files: [pendingFile],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaPrivilegeOfferError);
        expect(JSON.stringify(exit)).toContain("api.auto_expose_new_tables");
        expect(JSON.stringify(exit)).toContain(
          "migrations new revoke_api_privileges --template revoke-api-privileges",
        );
        expect(JSON.stringify(exit)).toContain("schema pull --force");
        expect(JSON.stringify(exit)).not.toContain("supabase migrations pull");
      }
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Remote default privileges differ from migration replay.",
        }),
      );
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Detected host-vs-replay privilege SQL (will not run).",
        }),
      );
      expect(ctx.out.messages).not.toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Declarations and migrations are not in sync.",
        }),
      );
      expect(ctx.out.stdoutText).toContain("ALTER DEFAULT PRIVILEGES");
      expect(ctx.applyCalls).toBe(1);
      expect(ctx.remoteApplyCalls).toBe(0);
      expect(ctx.appliedVersions).toEqual([]);
    });
  });

  it.live("applies a pending revoke instead of offering turn-off again", () => {
    const ctx = setup({
      declarations: false,
      drift: true,
      driftSql: ACL_SQL,
      files: [pendingFile, revokeFile],
      localRunning: false,
    });
    return Effect.gen(function* () {
      const result = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(true);
      expect(ctx.appliedVersions).toEqual([pendingFile.version, revokeFile.version]);
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Pending privilege migration will run on the remote.",
        }),
      );
      expect(ctx.out.messages).not.toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Declarations and migrations are not in sync.",
        }),
      );
      expect(ctx.out.stdoutText).not.toContain("ALTER DEFAULT PRIVILEGES");
      expect(ctx.out.promptConfirmCalls).toEqual([]);
    });
  });

  it.live("refuses live-edit when a pending revoke sits next to unrelated catalog drift", () => {
    const ctx = setup({
      declarations: false,
      drift: true,
      driftSql: "CREATE TABLE extra (id int);",
      files: [pendingFile, revokeFile],
      history: [{ version: pendingFile.version, name: pendingFile.name }],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaRemoteDriftError);
        expect(JSON.stringify(exit)).toContain("supabase migrations diff --against linked --file");
        expect(JSON.stringify(exit)).not.toContain("api.auto_expose_new_tables");
      }
      expect(ctx.applyCalls).toBe(2);
    });
  });

  it.live("applies a pending revoke before declarations-ahead", () => {
    const ctx = setup({
      declarations: true,
      ahead: true,
      aheadSql: "GRANT EXECUTE ON FUNCTION public.accept_invitation() TO service_role;",
      drift: true,
      driftSql: ACL_SQL,
      files: [pendingFile, revokeFile],
      history: [{ version: pendingFile.version, name: pendingFile.name }],
    });
    return Effect.gen(function* () {
      const result = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(true);
      expect(ctx.appliedVersions).toEqual([pendingFile.version, revokeFile.version]);
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Pending privilege migration will run on the remote.",
        }),
      );
      expect(JSON.stringify(ctx.out.messages)).not.toContain("schema generate --name");
    });
  });

  it.live("refuses a pending file with no executable SQL", () => {
    const ctx = setup({
      declarations: false,
      files: [
        {
          ...pendingFile,
          name: "sneak",
          fileName: "20260101000000_sneak.sql",
          content: "-- empty stub\n",
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaEmptyMigrationStatementsError);
        expect(JSON.stringify(exit)).toContain("20260101000000_sneak.sql");
        expect(JSON.stringify(exit)).not.toContain("schema generate --name");
      }
      expect(ctx.remoteApplyCalls).toBe(0);
    });
  });

  it.live("applies a pending revoke when remote history already exists", () => {
    const ctx = setup({
      declarations: false,
      drift: true,
      driftSql: ACL_SQL,
      files: [pendingFile, revokeFile],
      history: [{ version: pendingFile.version, name: pendingFile.name }],
    });
    return Effect.gen(function* () {
      const result = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(true);
      expect(ctx.appliedVersions).toEqual([pendingFile.version, revokeFile.version]);
    });
  });

  it.live("refreshes declarations instead of live-edit for leftover function grants", () => {
    const ctx = setup({
      declarations: false,
      drift: true,
      driftSql: `GRANT EXECUTE ON FUNCTION public.accept_invitation() TO service_role;`,
      files: [revokeFile, pendingFile],
      history: [{ version: revokeFile.version, name: revokeFile.name }],
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaRemoteDriftError);
        expect(JSON.stringify(exit)).toContain("schema pull --force");
        expect(JSON.stringify(exit)).not.toContain("migrations diff --against");
        expect(JSON.stringify(exit)).not.toContain("repair --status applied");
      }
      expect(ctx.remoteApplyCalls).toBe(0);
    });
  });

  it.live("keeps a URL privilege offer on the selected database", () => {
    const ctx = setup({
      declarations: false,
      drift: true,
      driftSql: ACL_SQL,
      files: [pendingFile],
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
        skipVerify: false,
        dbUrl: "postgresql://postgres:secret@db.example/postgres",
      }).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "supabase migrations push --db-url <same-url> --allow-remote",
      );
    });
  });

  it.live("first-push clean applies pending files", () => {
    const ctx = setup({
      declarations: false,
      drift: false,
      files: [pendingFile],
    });
    return Effect.gen(function* () {
      const result = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(true);
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "No remote migration history yet. This is the first push.",
        }),
      );
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Replaying pending files on a shadow before live apply.",
        }),
      );
      expect(ctx.out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Catalog matches migration replay; pending files were verified on a shadow.",
        }),
      );
      expect(ctx.out.messages).not.toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Declarations and migrations are in sync.",
        }),
      );
      expect(ctx.remoteApplyCalls).toBe(1);
      expect(result.message).toContain("1 of 1 migration pending on the local database.");
      expect(result.nextActions).toEqual(["to apply it locally: supabase migrations apply"]);
    });
  });

  it.live("does not hint local apply when local history cannot be listed", () => {
    const ctx = setup({
      declarations: false,
      drift: false,
      files: [pendingFile],
      localHistoryFail: true,
    });
    return Effect.gen(function* () {
      const result = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(true);
      expect(result.message).not.toContain("pending on the local database");
      expect(result.nextActions).toEqual([]);
    });
  });

  it.live("does not hint local apply when the local database is down", () => {
    const ctx = setup({
      declarations: false,
      drift: false,
      files: [pendingFile],
      localRunning: false,
    });
    return Effect.gen(function* () {
      const result = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(true);
      expect(result.message).not.toContain("pending on the local database");
      expect(result.nextActions).toEqual([]);
    });
  });

  it.live("pending shadow probe failure leaves the remote unchanged", () => {
    const ctx = setup({
      declarations: false,
      drift: false,
      files: [pendingFile],
      applyFailPending: true,
    });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations(pushFlags).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaEngineError);
        expect(JSON.stringify(exit)).toContain("gen_random_bytes");
      }
      expect(ctx.out.messages).not.toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Declarations and migrations are in sync.",
        }),
      );
      expect(ctx.out.messages).not.toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Catalog matches migration replay; pending files were verified on a shadow.",
        }),
      );
      expect(ctx.remoteApplyCalls).toBe(0);
    });
  });
});
