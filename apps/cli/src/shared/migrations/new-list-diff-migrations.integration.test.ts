import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { classifyPlanHazards, type Plan } from "@supabase/pg-delta/plan";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import { SchemaEmptyHistoryReplayError } from "../schema/schema-errors.ts";
import { SchemaStateStore } from "../schema/schema-state.service.ts";
import type { SchemaPlanView } from "../schema/schema-types.ts";
import { diffMigrations } from "./diff-migrations.ts";
import { listMigrations } from "./list-migrations.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";
import { newMigration } from "./new-migration.ts";

const file = {
  version: "20260101000000",
  name: "init",
  fileName: "20260101000000_init.sql",
  absolutePath: "/tmp/migrations/20260101000000_init.sql",
  content: "select 1;",
  transactional: true,
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
    files: changes
      ? [
          {
            sequence: 1,
            suffix: null,
            sql: "create table t (id int);",
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

const state = Layer.succeed(
  SchemaStateStore,
  SchemaStateStore.of({
    readJournal: Effect.succeed(Option.none()),
    writeJournal: () => Effect.void,
    clearJournal: Effect.void,
    withLock: (effect) => effect,
  }),
);

const localTargetValue = {
  kind: "local" as const,
  identity: "local:default",
  connectionString: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
  disposable: true,
  durable: false,
  connectionVerified: true,
};

const linkedTargetValue = {
  kind: "linked" as const,
  identity: "abcdefghijklmnop",
  connectionString: "postgresql://postgres:secret@db.example/postgres",
  disposable: false,
  durable: true,
  connectionVerified: false,
  projectRef: "abcdefghijklmnop",
};

const urlTargetValue = {
  kind: "url" as const,
  identity: "connection-string",
  connectionString: "postgresql://postgres:secret@db.example/postgres",
  disposable: false,
  durable: true,
  connectionVerified: false,
};

function targetLayer(
  target: typeof localTargetValue | typeof linkedTargetValue | typeof urlTargetValue,
) {
  return Layer.succeed(
    DatabaseTargetResolver,
    DatabaseTargetResolver.of({
      resolve: () => Effect.succeed(target),
    }),
  );
}

const localTarget = targetLayer(localTargetValue);

describe("newMigration", () => {
  it.live("writes an empty migration file", () => {
    const created = { ...file, name: "add_billing", fileName: "20260101000000_add_billing.sql" };
    const layer = Layer.mergeAll(
      mockOutput({ interactive: false }).layer,
      state,
      Layer.succeed(
        MigrationRepository,
        MigrationRepository.of({
          listLocal: Effect.succeed([]),
          createEmpty: (_name, content = "") => Effect.succeed({ ...created, content }),
          writeFetched: () => Effect.die("unused"),
          writeGenerated: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
        }),
      ),
    );
    return Effect.gen(function* () {
      const result = yield* newMigration({ name: "add_billing" }).pipe(Effect.provide(layer));
      expect(result.mutatedFiles).toBe(true);
      expect(result.data).toEqual(
        expect.objectContaining({ file: created.fileName, version: created.version }),
      );
      expect(result.nextActions).toEqual(["to add SQL before apply or push: edit the new file"]);
    });
  });

  it.live("seeds the turn-off revoke template and points at push first", () => {
    const created = {
      ...file,
      name: "revoke_api_privileges",
      fileName: "20260101000000_revoke_api_privileges.sql",
      content: "",
    };
    let written = "";
    const layer = Layer.mergeAll(
      mockOutput({ interactive: false }).layer,
      state,
      Layer.succeed(
        MigrationRepository,
        MigrationRepository.of({
          listLocal: Effect.succeed([]),
          createEmpty: (_name, content = "") =>
            Effect.sync(() => {
              written = content;
              return { ...created, content };
            }),
          writeFetched: () => Effect.die("unused"),
          writeGenerated: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
        }),
      ),
    );
    return Effect.gen(function* () {
      const result = yield* newMigration({
        name: "revoke_api_privileges",
        template: "revoke-api-privileges",
      }).pipe(Effect.provide(layer));
      expect(written).toContain("revoke execute on functions");
      expect(result.nextActions).toEqual([
        "to deploy: supabase migrations push",
        "to apply it locally: supabase migrations apply",
      ]);
      written = "";
      yield* newMigration({ name: "revoke_api_privileges" }).pipe(Effect.provide(layer));
      expect(written).toContain("revoke execute on functions");
    });
  });
});

function listLayer(opts: {
  readonly files?: ReadonlyArray<typeof file>;
  readonly history?: ReadonlyArray<{ version: string; name: string }>;
  readonly target?: typeof localTargetValue | typeof linkedTargetValue | typeof urlTargetValue;
}) {
  return Layer.mergeAll(
    mockOutput({ interactive: false }).layer,
    targetLayer(opts.target ?? localTargetValue),
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
        listRemote: () => Effect.succeed(opts.history ?? []),
        listRemoteStatements: () => Effect.succeed([]),
        showServerVersion: () => Effect.succeed(undefined),
        listInstalledExtensions: () => Effect.die("unused"),
        applyPending: () => Effect.die("unused"),
        markApplied: () => Effect.die("unused"),
      }),
    ),
  );
}

describe("listMigrations", () => {
  it.live("lists nothing when both sides are empty", () => {
    return Effect.gen(function* () {
      const result = yield* listMigrations({ against: "local" }).pipe(
        Effect.provide(listLayer({})),
      );
      expect(result.status).toBe("clean");
      expect(result.message).toBe("No migrations on the local database.");
      expect(result.body).toBeUndefined();
      expect(result.nextActions).toEqual([]);
      expect(result.data).toEqual(
        expect.objectContaining({
          status: "clean",
          applied: 0,
          pending: 0,
          remote_only: 0,
          history: "matched",
          migrations: [],
          files: [],
        }),
      );
    });
  });

  it.live("lists applied files when history matches", () => {
    return Effect.gen(function* () {
      const result = yield* listMigrations({ against: "local" }).pipe(
        Effect.provide(
          listLayer({ files: [file], history: [{ version: file.version, name: file.name }] }),
        ),
      );
      expect(result.status).toBe("clean");
      expect(result.message).toBe(
        "1 migration applied on the local database. History matches files.",
      );
      expect(result.body).toContain("20260101000000");
      expect(result.body).toContain("applied");
      expect(result.nextActions).toEqual([]);
      expect(result.data).toEqual(
        expect.objectContaining({
          status: "clean",
          applied: 1,
          pending: 0,
          remote_only: 0,
          history: "matched",
          migrations: [{ version: file.version, name: file.name, local: true, remote: true }],
          files: [{ name: file.name, version: file.version, status: "applied" }],
        }),
      );
    });
  });

  it.live("points pending local files at migrations apply", () => {
    return Effect.gen(function* () {
      const result = yield* listMigrations({ against: "local" }).pipe(
        Effect.provide(listLayer({ files: [file] })),
      );
      expect(result.status).toBe("clean");
      expect(result.message).toBe("1 of 1 migration pending on the local database.");
      expect(result.body).toContain("pending");
      expect(result.nextActions).toEqual(["to apply it locally: supabase migrations apply"]);
      expect(result.data).toEqual(
        expect.objectContaining({
          applied: 0,
          pending: 1,
          remote_only: 0,
          history: "pending",
        }),
      );
    });
  });

  it.live("points pending linked files at migrations push", () => {
    return Effect.gen(function* () {
      const result = yield* listMigrations({ against: "linked" }).pipe(
        Effect.provide(listLayer({ files: [file], target: linkedTargetValue })),
      );
      expect(result.message).toBe("1 of 1 migration pending on the linked project.");
      expect(result.nextActions).toEqual(["to deploy: supabase migrations push"]);
      expect(result.data).toEqual(expect.objectContaining({ history: "pending", pending: 1 }));
    });
  });

  it.live("points pending URL files at push --db-url, not the linked project", () => {
    return Effect.gen(function* () {
      const result = yield* listMigrations({
        against: "postgresql://postgres:secret@db.example/postgres",
      }).pipe(Effect.provide(listLayer({ files: [file], target: urlTargetValue })));
      expect(result.message).toBe("1 of 1 migration pending on the given database.");
      expect(result.nextActions).toEqual([
        "to deploy: supabase migrations push --db-url <same-url> --allow-remote",
      ]);
    });
  });

  it.live("points remote-only history at migrations pull and stays exit 0", () => {
    return Effect.gen(function* () {
      const result = yield* listMigrations({ against: "linked" }).pipe(
        Effect.provide(
          listLayer({
            history: [{ version: "19990101000000", name: "from_ci" }],
            target: linkedTargetValue,
          }),
        ),
      );
      expect(result.status).toBe("clean");
      expect(result.message).toBe("1 remote-only migration on the linked project (no local file).");
      expect(result.body).toContain("remote-only");
      expect(result.nextActions).toEqual([
        "to fetch missing files: supabase migrations pull --from linked",
        "to refresh declarations: supabase schema pull --from linked",
      ]);
      expect(result.data).toEqual(
        expect.objectContaining({
          applied: 0,
          pending: 0,
          remote_only: 1,
          history: "remote_only",
        }),
      );
    });
  });

  it.live("treats pending plus remote-only as a conflict and still exits 0", () => {
    return Effect.gen(function* () {
      const result = yield* listMigrations({ against: "linked" }).pipe(
        Effect.provide(
          listLayer({
            files: [file],
            history: [{ version: "19990101000000", name: "from_ci" }],
            target: linkedTargetValue,
          }),
        ),
      );
      expect(result.status).toBe("clean");
      expect(result.message).toContain("pending");
      expect(result.message).toContain("remote-only");
      expect(result.message).not.toMatch(/drift/i);
      expect(result.nextActions).toEqual([
        "to fetch missing files: supabase migrations pull --from linked",
        "to refresh declarations: supabase schema pull --from linked",
      ]);
      expect(result.data).toEqual(
        expect.objectContaining({
          applied: 0,
          pending: 1,
          remote_only: 1,
          history: "conflict",
        }),
      );
    });
  });
});

function diffLayer(
  opts: {
    readonly files?: ReadonlyArray<typeof file>;
    readonly history?: ReadonlyArray<{ version: string; name: string }>;
  } = {},
) {
  const files = opts.files ?? [file];
  const history = opts.history ?? files.map((item) => ({ version: item.version, name: item.name }));
  const replayed: Array<ReadonlyArray<string>> = [];
  let platformProvisions = 0;
  return {
    replayed,
    get platformProvisions() {
      return platformProvisions;
    },
    layer: Layer.mergeAll(
      mockOutput({ interactive: false }).layer,
      localTarget,
      Layer.succeed(
        MigrationRepository,
        MigrationRepository.of({
          listLocal: Effect.succeed(files),
          createEmpty: () => Effect.die("unused"),
          writeFetched: () => Effect.die("unused"),
          writeGenerated: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
        }),
      ),
      Layer.succeed(
        MigrationRunner,
        MigrationRunner.of({
          listRemote: () => Effect.succeed(history),
          listRemoteStatements: () => Effect.succeed([]),
          showServerVersion: () => Effect.succeed(undefined),
          listInstalledExtensions: () => Effect.die("unused"),
          applyPending: (_pool, applied) =>
            Effect.sync(() => {
              replayed.push(applied.map((item) => item.version));
              return { applied: applied.map((item) => item.version), skipped: [] };
            }),
          markApplied: () => Effect.die("unused"),
        }),
      ),
      Layer.succeed(
        PgDeltaSchemaEngine,
        PgDeltaSchemaEngine.of({
          exportSchema: () => Effect.die("unused"),
          planFiles: () => Effect.die("unused"),
          diffPools: () => Effect.succeed(planView(true)),
          applyPlan: () => Effect.die("unused"),
          provisionShadow: Effect.die("unused"),
          provisionPlatform: Effect.sync(() => {
            platformProvisions += 1;
            return { url: "postgresql://postgres:postgres@127.0.0.1:1/postgres" };
          }),
          provisionMigrations: Effect.die("provisionMigrations must not replay pending files"),
        }),
      ),
    ),
  };
}

describe("diffMigrations", () => {
  it.live("previews drift against the named target", () => {
    const ctx = diffLayer();
    return Effect.gen(function* () {
      const result = yield* diffMigrations({ against: "local" }).pipe(
        Effect.provide(ctx.layer),
        Effect.provide(BunServices.layer),
      );
      expect(result.status).toBe("drift");
      expect(result.body).toBe("create table t (id int);");
      expect(result.data["sql"]).toBe("create table t (id int);");
      expect(result.data["files"]).toEqual([
        expect.objectContaining({ sql: "create table t (id int);" }),
      ]);
      expect(result.mutatedDatabase).toBe(false);
    });
  });

  it.live("defaults --against to local and does not send the next step to linked pull", () => {
    const ctx = diffLayer();
    return Effect.gen(function* () {
      const result = yield* diffMigrations({}).pipe(
        Effect.provide(ctx.layer),
        Effect.provide(BunServices.layer),
      );
      expect(result.nextActions).toEqual([
        "to write a migration file: supabase migrations diff --against local --file supabase/migrations/<version>_<name>.sql",
        "to record it as applied without running SQL: supabase migration repair --local --status applied <version>",
      ]);
    });
  });

  it.live("replays only applied history, not pending local files", () => {
    const pending = {
      ...file,
      version: "20260201000000",
      name: "billing",
      fileName: "20260201000000_billing.sql",
      absolutePath: "/tmp/migrations/20260201000000_billing.sql",
    };
    const ctx = diffLayer({
      files: [file, pending],
      history: [{ version: file.version, name: file.name }],
    });
    return Effect.gen(function* () {
      yield* diffMigrations({ against: "linked" }).pipe(
        Effect.provide(ctx.layer),
        Effect.provide(BunServices.layer),
      );
      expect(ctx.replayed).toEqual([[file.version]]);
    });
  });

  it.live("refuses empty history when local files exist, before shadow", () => {
    const ctx = diffLayer({ files: [file], history: [] });
    return Effect.gen(function* () {
      const exit = yield* diffMigrations({ against: "local" }).pipe(
        Effect.provide(ctx.layer),
        Effect.provide(BunServices.layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaEmptyHistoryReplayError);
        expect(JSON.stringify(exit)).toContain("supabase migrations apply");
        expect(JSON.stringify(exit)).not.toContain("db diff");
      }
      expect(ctx.platformProvisions).toBe(0);
      expect(ctx.replayed).toEqual([]);
    });
  });

  it.live("captures adopt when history and local files are empty", () => {
    const ctx = diffLayer({ files: [], history: [] });
    return Effect.gen(function* () {
      const result = yield* diffMigrations({ against: "local" }).pipe(
        Effect.provide(ctx.layer),
        Effect.provide(BunServices.layer),
      );
      expect(result.status).toBe("drift");
      expect(result.data["sql"]).toBe("create table t (id int);");
      expect(ctx.platformProvisions).toBe(1);
    });
  });
});
