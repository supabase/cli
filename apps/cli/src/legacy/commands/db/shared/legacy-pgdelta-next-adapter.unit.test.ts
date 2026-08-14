import { it } from "@effect/vitest";
import { buildFactBase, type Fact, type StableId } from "@supabase/pg-delta/core";
import { renderPlanFiles, ShadowLoadError } from "@supabase/pg-delta/frontends";
import { plan, type Action } from "@supabase/pg-delta/plan";
import { Effect } from "effect";
import { Pool } from "pg";
import { describe, expect } from "vitest";

import {
  legacyPgDeltaNextAdapterLayerFromLibraries,
  legacyFilterPgDeltaNextPlatformParameterAclDiagnostics,
  legacyPgDeltaNextProfile,
  legacyPgDeltaNextUserOwnedParameterAcls,
  legacySummarizePgDeltaNextHazards,
  legacySummarizePgDeltaNextRemovals,
  type LegacyPgDeltaNextLibraries,
} from "./legacy-pgdelta-next-adapter.layer.ts";
import {
  LegacyPgDeltaNextAdapter,
  LegacyPgDeltaNextError,
} from "./legacy-pgdelta-next-adapter.service.ts";

interface FakeFactBase {
  readonly id: string;
}

interface FakePlanOptions {
  readonly managedView: string;
}

interface FakePlan {
  readonly source: string;
  readonly desired: string;
}

interface FakeSubject {
  readonly id: string;
}

function fakeDiagnostic(code: string, subject: string) {
  return {
    code,
    severity: "warning" as const,
    subject: { id: subject },
    message: `${code} message`,
    context: { detail: code },
  };
}

function setupLibraries(sourcePool: Pool, desiredPool: Pool) {
  const state = {
    resolveCalls: [] as Array<{
      pool: Pool;
      options: {
        restrictToApplier?: boolean;
        redactSecrets?: boolean;
        skipBaseline?: boolean;
      };
      schema?: readonly string[];
    }>,
    extractCalls: [] as Array<{ pool: Pool; options: object | undefined }>,
    planCalls: [] as Array<{
      source: FakeFactBase;
      desired: FakeFactBase;
      options: FakePlanOptions & { redactSecrets: boolean };
    }>,
    renderOptions: [] as Array<{ allowDrops: boolean }>,
    exportInputs: [] as object[],
    declarativeInputs: [] as object[],
    snapshotMetadata: [] as object[],
  };

  const extract = async (
    pool: Pool,
    options?: { redactSecrets?: boolean; statementTimeoutMs?: number },
  ) => {
    state.extractCalls.push({ pool, options });
    const source = pool === sourcePool;
    if (!source && pool !== desiredPool) {
      throw new Error("unexpected pool passed to fake extractor");
    }
    return {
      factBase: { id: source ? "source-facts" : "desired-facts" },
      pgVersion: source ? "15.9" : "17.6",
      diagnostics: [
        fakeDiagnostic(source ? "source-warning" : "desired-warning", source ? "s" : "d"),
      ],
    };
  };

  const libraries: LegacyPgDeltaNextLibraries<
    FakeFactBase,
    FakePlanOptions,
    FakePlan,
    FakeSubject
  > = {
    resolveProfile: async (pool, options, schema) => {
      state.resolveCalls.push({ pool, options, ...(schema !== undefined ? { schema } : {}) });
      return {
        id: "supabase",
        planOptions: { managedView: "shared-profile-options" },
        extract,
      };
    },
    plan: (source, desired, options) => {
      state.planCalls.push({ source, desired, options });
      return { source: source.id, desired: desired.id };
    },
    renderPlanFiles: (_generatedPlan, options) => {
      state.renderOptions.push(options);
      return {
        changes: true,
        files: [
          {
            suffix: "_1",
            contents: "CREATE TABLE public.widgets (id integer, display_name text);\n",
            transactional: true,
            actionCount: 2,
          },
          {
            suffix: "_2",
            contents:
              "-- pg-delta: transaction=false\nSET check_function_bodies = off;\n\nGRANT SELECT ON TABLE public.widgets TO anon;\n\nRESET ALL;\n",
            transactional: false,
            actionCount: 1,
          },
        ],
      };
    },
    buildSchemaExport: async (_pool, input) => {
      state.exportInputs.push(input);
      return {
        files: [{ name: "schemas/public/tables/items.sql", sql: "create table items();" }],
        diagnostics: [fakeDiagnostic("export-warning", "export")],
        manifest: {
          redactSecrets: true,
          scope: "database",
          profile: "supabase",
          defaultOwner: "postgres",
        },
      };
    },
    planSchemaFiles: async (_targetPool, _shadowPool, _files, input) => {
      state.declarativeInputs.push(input);
      return {
        plan: { source: "target-facts", desired: "loaded-files" },
        loadDiagnostics: [fakeDiagnostic("load-warning", "load")],
        targetDiagnostics: [fakeDiagnostic("target-warning", "target")],
        driftDiagnostics: [fakeDiagnostic("unmodeled_drift", "drift")],
        skipped: [{ file: "roles.sql", stmt: "create role ignored" }],
      };
    },
    serializeSnapshot: (factBase, metadata) => {
      state.snapshotMetadata.push(metadata);
      return JSON.stringify({ factBase: factBase.id, metadata });
    },
    serializePlan: (generatedPlan) => {
      return JSON.stringify(generatedPlan);
    },
    summarizeRemovals: () => ({
      extensions: ["pgcrypto"],
      extensionIntents: [
        { extension: "pg_cron", intentKind: "job", key: "refresh download metrics" },
      ],
    }),
    summarizeHazards: (_generatedPlan, diagnostics) => ({
      actions: [{ actionIndex: 0, kinds: ["data_loss"] }],
      dataLoss: [{ actionIndex: 0, sql: "TRUNCATE TABLE public.audit_log" }],
      coverage: diagnostics.some((diagnostic) => diagnostic.code === "unmodeled_drift")
        ? ["unmodeled_drift"]
        : [],
      kinds: diagnostics.some((diagnostic) => diagnostic.code === "unmodeled_drift")
        ? ["data_loss", "unmodeled_drift"]
        : ["data_loss"],
    }),
    encodeSubject: (subject) => `subject:${subject.id}`,
  };

  return {
    state,
    layer: legacyPgDeltaNextAdapterLayerFromLibraries(libraries),
  };
}

const unusedLibraries: LegacyPgDeltaNextLibraries<
  string,
  Record<string, never>,
  FakePlan,
  string
> = {
  resolveProfile: async () => {
    throw new Error("unused");
  },
  plan: () => ({ source: "unused", desired: "unused" }),
  renderPlanFiles: () => ({ changes: false, files: [] }),
  buildSchemaExport: async () => ({
    files: [],
    diagnostics: [],
    manifest: { redactSecrets: true, scope: "database" },
  }),
  planSchemaFiles: async () => ({
    plan: { source: "unused", desired: "unused" },
    loadDiagnostics: [],
    targetDiagnostics: [],
    driftDiagnostics: [],
    skipped: [],
  }),
  serializeSnapshot: () => "unused",
  serializePlan: () => "unused",
  summarizeRemovals: () => ({ extensions: [], extensionIntents: [] }),
  summarizeHazards: () => ({ actions: [], dataLoss: [], coverage: [], kinds: [] }),
  encodeSubject: (subject) => subject,
};

describe("LegacyPgDeltaNextAdapter", () => {
  it("summarizes only root extension and extension-intent removals", () => {
    expect(
      legacySummarizePgDeltaNextRemovals({
        deltas: [
          { verb: "remove", fact: { id: { kind: "extension", name: "uuid-ossp" }, payload: {} } },
          { verb: "remove", fact: { id: { kind: "extension", name: "pgcrypto" }, payload: {} } },
          {
            verb: "remove",
            fact: {
              id: { kind: "extension", name: "nested-extension" },
              parent: { kind: "schema", name: "extensions" },
              payload: {},
            },
          },
          {
            verb: "remove",
            fact: {
              id: {
                kind: "extensionIntent",
                ext: "pg_cron",
                intentKind: "job",
                key: "refresh download metrics",
              },
              payload: {},
            },
          },
          {
            verb: "remove",
            fact: {
              id: { kind: "comment", target: { kind: "extension", name: "pgcrypto" } },
              payload: {},
            },
          },
          {
            verb: "unlink",
            edge: {
              from: { kind: "extension", name: "pgcrypto" },
              to: { kind: "schema", name: "extensions" },
              kind: "depends",
            },
          },
        ],
      }),
    ).toEqual({
      extensions: ["pgcrypto", "uuid-ossp"],
      extensionIntents: [
        { extension: "pg_cron", intentKind: "job", key: "refresh download metrics" },
      ],
    });
  });

  it("derives semantic hazards and destructive non-DROP actions from the typed plan", () => {
    const destructiveAlter: Action = {
      sql: 'ALTER TABLE "public"."items" ALTER COLUMN "quantity" TYPE smallint;',
      verb: "alter",
      produces: [],
      consumes: [],
      destroys: [],
      releases: [],
      transactionality: "transactional",
      lockClass: "accessExclusive",
      newSegmentBefore: false,
      dataLoss: "destructive",
      rewriteRisk: true,
    };

    expect(
      legacySummarizePgDeltaNextHazards({ actions: [destructiveAlter] }, [
        {
          code: "unmodeled_drift",
          severity: "warning",
          message: "a desired prerequisite is absent from the target",
        },
      ]),
    ).toEqual({
      actions: [
        {
          actionIndex: 0,
          kinds: ["data_loss", "rewrite_risk", "access_exclusive_lock"],
        },
      ],
      dataLoss: [{ actionIndex: 0, sql: destructiveAlter.sql }],
      coverage: ["unmodeled_drift"],
      kinds: ["data_loss", "rewrite_risk", "access_exclusive_lock", "unmodeled_drift"],
    });
  });

  it("filters platform parameter ACL coverage without hiding user-owned ACLs", () => {
    const diagnostics = [
      {
        origin: "declarativeLoad" as const,
        code: "unmodeled_kind",
        severity: "warning" as const,
        message: "2 unmodeled parameter ACLs",
        context: {
          kind: "parameter ACL",
          count: 2,
          samples: ["log_min_messages", "work_mem"],
        },
      },
      {
        origin: "declarativeLoad" as const,
        code: "unsupported_extension",
        severity: "warning" as const,
        message: "extension is externally managed",
      },
    ];

    expect(legacyFilterPgDeltaNextPlatformParameterAclDiagnostics(diagnostics, [])).toEqual([
      diagnostics[1],
    ]);
    expect(
      legacyFilterPgDeltaNextPlatformParameterAclDiagnostics(diagnostics, ["work_mem"]),
    ).toEqual([
      {
        ...diagnostics[0],
        message:
          '1 unmodeled "parameter ACL" object not managed by this engine (e.g. work_mem) — v1 detects but does not model this kind',
        context: { kind: "parameter ACL", count: 1, samples: ["work_mem"] },
      },
      diagnostics[1],
    ]);
  });

  it("recognizes only the exact Supabase platform parameter grant tuples", () => {
    expect(
      legacyPgDeltaNextUserOwnedParameterAcls([
        { name: "log_min_messages", grantee: "supabase_admin", privilege: "SET" },
        { name: "log_min_messages", grantee: "app_user", privilege: "SET" },
        { name: "work_mem", grantee: "supabase_realtime_admin", privilege: "SET" },
        { name: "work_mem", grantee: "app_user", privilege: "SET" },
      ]),
    ).toEqual(["log_min_messages", "work_mem"]);
    expect(
      legacyPgDeltaNextUserOwnedParameterAcls([
        { name: "log_min_messages", grantee: "supabase_admin", privilege: "ALTER SYSTEM" },
        { name: "log_min_messages", grantee: "supabase_admin", privilege: "SET" },
        { name: "log_min_messages", grantee: "supabase_realtime_admin", privilege: "SET" },
      ]),
    ).toEqual([]);
    expect(
      legacyPgDeltaNextUserOwnedParameterAcls([
        { name: "log_min_messages", grantee: "supabase_realtime_admin", privilege: "ALTER SYSTEM" },
      ]),
    ).toEqual(["log_min_messages"]);
  });

  it("renders selected-schema state without leaking other user or platform objects", () => {
    const schemaPublic = { kind: "schema", name: "public" } satisfies StableId;
    const schemaAuth = { kind: "schema", name: "auth" } satisfies StableId;
    const existingRole = { kind: "role", name: "app_owner" } satisfies StableId;
    const selectedTable = {
      kind: "table",
      schema: "public",
      name: "selected_items",
    } satisfies StableId;
    const unselectedSchema = { kind: "schema", name: "private_data" } satisfies StableId;
    const unselectedTable = {
      kind: "table",
      schema: "private_data",
      name: "hidden_items",
    } satisfies StableId;
    const platformTable = {
      kind: "table",
      schema: "auth",
      name: "hidden_platform_table",
    } satisfies StableId;
    const customRole = { kind: "role", name: "hidden_custom_role" } satisfies StableId;

    const fact = (id: StableId, payload: Fact["payload"] = {}, parent?: StableId): Fact =>
      parent === undefined ? { id, payload } : { id, parent, payload };

    const sourceFacts: Fact[] = [fact(schemaPublic), fact(schemaAuth), fact(existingRole)];
    const desiredFacts: Fact[] = [
      ...sourceFacts,
      fact(
        selectedTable,
        { persistence: "p", partitionBound: null, partitionKey: null, parentTable: null },
        schemaPublic,
      ),
      fact(
        { kind: "comment", target: selectedTable },
        { text: "selected table metadata" },
        selectedTable,
      ),
      fact(unselectedSchema),
      fact(
        unselectedTable,
        { persistence: "p", partitionBound: null, partitionKey: null, parentTable: null },
        unselectedSchema,
      ),
      fact(
        platformTable,
        { persistence: "p", partitionBound: null, partitionKey: null, parentTable: null },
        schemaAuth,
      ),
      fact(customRole, { login: true, config: [] }),
    ];
    const desiredEdges = [{ from: selectedTable, to: existingRole, kind: "owner" }] as const;

    const profile = legacyPgDeltaNextProfile(["public", "auth"]);
    const generated = plan(
      buildFactBase(sourceFacts, []),
      buildFactBase(desiredFacts, [...desiredEdges]),
      { policy: profile.policy },
    );
    const rendered = renderPlanFiles(generated, { allowDrops: true });
    const sql = rendered.files.map((file) => file.contents).join("\n");

    expect(sql).toContain('CREATE TABLE "public"."selected_items"');
    expect(sql).toContain("selected table metadata");
    expect(sql).toContain('OWNER TO "app_owner"');
    for (const leakedName of [
      "private_data",
      "hidden_items",
      "hidden_platform_table",
      "hidden_custom_role",
    ]) {
      expect(sql).not.toContain(leakedName);
    }
  });

  it.effect(
    "resolves one shared profile for a pool-to-pool diff and emits structured debug data",
    () => {
      const sourcePool = new Pool();
      const desiredPool = new Pool();
      const { layer, state } = setupLibraries(sourcePool, desiredPool);

      return Effect.gen(function* () {
        const adapter = yield* LegacyPgDeltaNextAdapter;
        const result = yield* adapter.diff({
          sourcePool,
          desiredPool,
          allowDrops: true,
          debug: true,
          schema: ["public"],
          formatOptions: '{"keywordCase":"upper","indent":4}',
        });

        expect(state.resolveCalls).toEqual([
          {
            pool: sourcePool,
            options: { redactSecrets: true },
            schema: ["public"],
          },
        ]);
        expect(state.extractCalls).toEqual([
          { pool: sourcePool, options: { redactSecrets: true } },
          { pool: desiredPool, options: { redactSecrets: true } },
        ]);
        expect(state.planCalls).toEqual([
          {
            source: { id: "source-facts" },
            desired: { id: "desired-facts" },
            options: { redactSecrets: true, managedView: "shared-profile-options" },
          },
        ]);
        expect(state.renderOptions).toEqual([{ allowDrops: true }]);
        expect(result.files).toMatchObject([
          { sequence: 1, suffix: "_1", transactionMode: "transactional", actionCount: 2 },
          { sequence: 2, suffix: "_2", transactionMode: "none", actionCount: 1 },
        ]);
        expect(result.diagnostics.map(({ origin, subject }) => ({ origin, subject }))).toEqual([
          { origin: "source", subject: "subject:s" },
          { origin: "desired", subject: "subject:d" },
        ]);
        expect(result.debug).toEqual({
          sourceSnapshot: expect.stringContaining("source-facts"),
          desiredSnapshot: expect.stringContaining("desired-facts"),
          plan: JSON.stringify({ source: "source-facts", desired: "desired-facts" }),
        });
        expect(state.snapshotMetadata).toEqual([
          { pgVersion: "15.9", redactSecrets: true, profile: "supabase" },
          { pgVersion: "17.6", redactSecrets: true, profile: "supabase" },
        ]);
        yield* Effect.promise(() => Promise.all([sourcePool.end(), desiredPool.end()]));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "normalizes declarative export and planning results with reorder enabled by default",
    () => {
      const targetPool = new Pool();
      const shadowPool = new Pool();
      const { layer, state } = setupLibraries(targetPool, shadowPool);

      return Effect.gen(function* () {
        const adapter = yield* LegacyPgDeltaNextAdapter;
        const exported = yield* adapter.exportDeclarativeSchema({
          pool: targetPool,
          formatOptions:
            '{"keywordCase":"lower","commaStyle":"leading","indent":4,"maxWidth":100,"alignColumns":true,"alignKeyValues":false,"preserveRoutineBodies":true,"preserveViewBodies":false,"preserveRuleBodies":true,"ignored":"value"}',
        });
        expect(exported.files).toEqual([
          { name: "schemas/public/tables/items.sql", sql: "create table items();" },
        ]);
        expect(exported.manifest).toEqual({
          redactSecrets: true,
          scope: "database",
          profile: "supabase",
          defaultOwner: "postgres",
          files: ["schemas/public/tables/items.sql"],
        });
        expect(exported.diagnostics[0]).toMatchObject({
          origin: "export",
          subject: "subject:export",
        });
        expect(state.exportInputs).toHaveLength(1);
        expect(state.exportInputs[0]).toMatchObject({
          layout: "grouped",
          format: {
            keywordCase: "lower",
            commaStyle: "leading",
            indent: 4,
            maxWidth: 100,
            alignColumns: true,
            alignKeyValues: false,
            preserveRoutineBodies: true,
            preserveViewBodies: false,
            preserveRuleBodies: true,
          },
        });
        expect(state.exportInputs[0]).not.toHaveProperty("formatOptions");

        yield* adapter.exportDeclarativeSchema({
          pool: targetPool,
        });
        expect(state.exportInputs[1]).toMatchObject({
          format: { keywordCase: "lower", maxWidth: 180 },
        });

        const planned = yield* adapter.planDeclarativeSchema({
          targetPool,
          shadowPool,
          files: exported.files,
          allowDrops: true,
          debug: true,
          formatOptions: "null",
        });
        expect(state.declarativeInputs).toHaveLength(1);
        expect(state.declarativeInputs[0]).toMatchObject({
          reorder: true,
          isolatedShadow: true,
          seedAssumedSchemas: false,
          strictDataStatements: true,
        });
        expect(planned.diagnostics.map((diagnostic) => diagnostic.origin)).toEqual([
          "declarativeLoad",
          "declarativeTarget",
          "declarativeDrift",
          "declarativeLoad",
        ]);
        expect(planned.diagnostics.at(-2)).toMatchObject({
          origin: "declarativeDrift",
          code: "unmodeled_drift",
          subject: "subject:drift",
        });
        // Statements the loader could not model become coverage diagnostics here, so
        // they travel the shared diagnostic report (warn by default, fail under
        // `--strict-coverage`) instead of only living in the unread `skipped` field.
        expect(planned.diagnostics.at(-1)).toEqual({
          origin: "declarativeLoad",
          code: "skipped_statement",
          severity: "warning",
          subject: "roles.sql",
          message:
            "pg-delta could not load a declarative schema statement from roles.sql: create role ignored",
          context: { file: "roles.sql", statement: "create role ignored" },
        });
        expect(planned.hazards).toEqual({
          actions: [{ actionIndex: 0, kinds: ["data_loss"] }],
          dataLoss: [{ actionIndex: 0, sql: "TRUNCATE TABLE public.audit_log" }],
          coverage: ["unmodeled_drift"],
          kinds: ["data_loss", "unmodeled_drift"],
        });
        expect(planned.skipped).toEqual([{ file: "roles.sql", statement: "create role ignored" }]);
        expect(planned.removals).toEqual({
          extensions: ["pgcrypto"],
          extensionIntents: [
            { extension: "pg_cron", intentKind: "job", key: "refresh download metrics" },
          ],
        });
        expect(planned.debug).toEqual({
          plan: JSON.stringify({ source: "target-facts", desired: "loaded-files" }),
        });
        expect(planned.files.map((file) => file.sql)).toEqual([
          "CREATE TABLE public.widgets (id integer, display_name text);\n",
          "-- pg-delta: transaction=false\nSET check_function_bodies = off;\n\nGRANT SELECT ON TABLE public.widgets TO anon;\n\nRESET ALL;\n",
        ]);
        expect(state.renderOptions).toEqual([{ allowDrops: true }]);
        yield* Effect.promise(() => Promise.all([targetPool.end(), shadowPool.end()]));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("preserves shadow-load diagnostics in the actionable error", () => {
    const targetPool = new Pool();
    const shadowPool = new Pool();
    const cause = new ShadowLoadError("2 files cannot apply", [
      {
        code: "stuck_statement",
        severity: "error",
        message: 'extensions/pg_cron.sql: extension "pg_cron" already exists',
        context: { rounds: 6 },
      },
      {
        code: "stuck_statement",
        severity: "error",
        message: 'extensions/pg_net.sql: extension "pg_net" already exists',
      },
    ]);
    const failingLayer = legacyPgDeltaNextAdapterLayerFromLibraries({
      ...unusedLibraries,
      planSchemaFiles: async () => {
        throw cause;
      },
    });

    return Effect.gen(function* () {
      const adapter = yield* LegacyPgDeltaNextAdapter;
      const error = yield* adapter
        .planDeclarativeSchema({
          targetPool,
          shadowPool,
          files: [],
          allowDrops: false,
          debug: false,
        })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(LegacyPgDeltaNextError);
      expect(error.message).toBe(
        'Declarative schema planning failed: 2 files cannot apply\n  - extensions/pg_cron.sql: extension "pg_cron" already exists\n  - extensions/pg_net.sql: extension "pg_net" already exists',
      );
      expect(error.diagnostics).toEqual([
        {
          code: "stuck_statement",
          severity: "error",
          message: 'extensions/pg_cron.sql: extension "pg_cron" already exists',
          context: { rounds: 6 },
        },
        {
          code: "stuck_statement",
          severity: "error",
          message: 'extensions/pg_net.sql: extension "pg_net" already exists',
        },
      ]);
      expect(error.cause).toBe(cause);
      yield* Effect.promise(() => Promise.all([targetPool.end(), shadowPool.end()]));
    }).pipe(Effect.provide(failingLayer));
  });
});
