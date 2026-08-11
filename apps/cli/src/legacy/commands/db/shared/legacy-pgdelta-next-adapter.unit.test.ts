import { it } from "@effect/vitest";
import {
  buildFactBase,
  encodeId,
  type DependencyEdge,
  type Fact,
  type StableId,
} from "@supabase/pg-delta/core";
import { renderPlanFiles, ShadowLoadError } from "@supabase/pg-delta/frontends";
import { plan } from "@supabase/pg-delta/plan";
import { Effect } from "effect";
import { Pool } from "pg";
import { describe, expect } from "vitest";

import {
  legacyPgDeltaNextAdapterLayer,
  legacyPgDeltaNextAdapterLayerFromLibraries,
  legacyFilterPgDeltaNextPlatformParameterAclDiagnostics,
  legacyPgDeltaNextProfile,
  legacyPgDeltaNextUserOwnedParameterAcls,
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
    serializedPlans: [] as FakePlan[],
    renderChanges: true,
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
      if (!state.renderChanges) return { changes: false, files: [] };
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
        skipped: [{ file: "roles.sql", stmt: "create role ignored" }],
      };
    },
    serializeSnapshot: (factBase, metadata) => {
      state.snapshotMetadata.push(metadata);
      return JSON.stringify({ factBase: factBase.id, metadata });
    },
    serializePlan: (generatedPlan) => {
      state.serializedPlans.push(generatedPlan);
      return JSON.stringify(generatedPlan);
    },
    summarizeRemovals: () => ({
      extensions: ["pgcrypto"],
      extensionIntents: [
        { extension: "pg_cron", intentKind: "job", key: "refresh download metrics" },
      ],
    }),
    encodeSubject: (subject) => `subject:${subject.id}`,
  };

  return {
    state,
    layer: legacyPgDeltaNextAdapterLayerFromLibraries(libraries),
  };
}

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

  it("composes the operation-scoped schema complement ahead of the Supabase policy", () => {
    const profile = legacyPgDeltaNextProfile(["public", "tenant"]);
    expect(profile.id).toBe("supabase");
    expect(profile.policy?.filter).toEqual([
      {
        match: {
          all: [
            { verb: ["add", "remove", "set", "link", "unlink"] },
            {
              not: {
                any: [
                  { schema: ["public", "tenant"] },
                  {
                    all: [{ kind: "schema" }, { name: ["public", "tenant"] }],
                  },
                  { target: { schema: ["public", "tenant"] } },
                  {
                    target: {
                      kind: "schema",
                      name: ["public", "tenant"],
                    },
                  },
                ],
              },
            },
          ],
        },
        action: "exclude",
      },
    ]);
    expect(profile.policy?.extends).toHaveLength(1);
  });

  it("renders only selected-schema state while preserving its metadata and dependencies", () => {
    const schemaPublic = { kind: "schema", name: "public" } satisfies StableId;
    const schemaAuth = { kind: "schema", name: "auth" } satisfies StableId;
    const existingRole = { kind: "role", name: "app_owner" } satisfies StableId;
    const existingExtension = { kind: "extension", name: "hstore" } satisfies StableId;
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
    const customExtension = {
      kind: "extension",
      name: "hidden_custom_extension",
    } satisfies StableId;
    const customPublication = {
      kind: "publication",
      name: "hidden_custom_publication",
    } satisfies StableId;
    const customFdw = { kind: "fdw", name: "hidden_custom_fdw" } satisfies StableId;

    const fact = (id: StableId, payload: Fact["payload"] = {}, parent?: StableId): Fact =>
      parent === undefined ? { id, payload } : { id, parent, payload };

    const sourceFacts: Fact[] = [
      fact(schemaPublic),
      fact(schemaAuth),
      fact(existingRole, { login: false, config: [] }),
      fact(existingExtension, { schema: "public", relocatable: true }),
    ];
    const sourceEdges: DependencyEdge[] = [
      { from: existingExtension, to: schemaPublic, kind: "depends" },
    ];
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
      fact(
        { kind: "comment", target: schemaPublic },
        { text: "selected schema metadata" },
        schemaPublic,
      ),
      fact(
        { kind: "acl", target: selectedTable, grantee: "PUBLIC" },
        { privileges: ["SELECT"], grantable: [] },
        selectedTable,
      ),
      fact(unselectedSchema),
      fact(
        unselectedTable,
        { persistence: "p", partitionBound: null, partitionKey: null, parentTable: null },
        unselectedSchema,
      ),
      fact(
        { kind: "comment", target: unselectedTable },
        { text: "unselected metadata" },
        unselectedTable,
      ),
      fact(
        platformTable,
        { persistence: "p", partitionBound: null, partitionKey: null, parentTable: null },
        schemaAuth,
      ),
      fact(customRole, { login: true, config: [] }),
      fact(customExtension, { schema: "public", relocatable: true }),
      fact(customPublication, {
        allTables: false,
        publish: ["insert", "update"],
        viaRoot: false,
      }),
      fact(customFdw, { handler: null, validator: null, options: [] }),
    ];
    const desiredEdges: DependencyEdge[] = [
      ...sourceEdges,
      { from: selectedTable, to: existingExtension, kind: "depends" },
      { from: selectedTable, to: existingRole, kind: "owner" },
    ];

    const profile = legacyPgDeltaNextProfile(["public", "auth"]);
    const generated = plan(
      buildFactBase(sourceFacts, sourceEdges),
      buildFactBase(desiredFacts, desiredEdges),
      { policy: profile.policy },
    );
    const rendered = renderPlanFiles(generated, { allowDrops: true });
    const sql = rendered.files.map((file) => file.contents).join("\n");

    expect(sql).toContain('CREATE TABLE "public"."selected_items"');
    expect(sql).toContain("selected table metadata");
    expect(sql).toContain("selected schema metadata");
    expect(sql).toContain('GRANT SELECT ON TABLE "public"."selected_items" TO PUBLIC');
    expect(sql).toContain('OWNER TO "app_owner"');
    for (const leakedName of [
      "private_data",
      "hidden_items",
      "hidden_platform_table",
      "hidden_custom_role",
      "hidden_custom_extension",
      "hidden_custom_publication",
      "hidden_custom_fdw",
      "unselected metadata",
    ]) {
      expect(sql).not.toContain(leakedName);
    }

    expect(generated.deltas).toContainEqual({
      verb: "link",
      edge: { from: selectedTable, to: existingExtension, kind: "depends" },
    });
    expect(generated.deltas).toContainEqual({
      verb: "link",
      edge: { from: selectedTable, to: existingRole, kind: "owner" },
    });
    const filtered = generated.filteredDeltas.map((delta) => {
      switch (delta.verb) {
        case "add":
        case "remove":
          return encodeId(delta.fact.id);
        case "set":
          return encodeId(delta.id);
        case "link":
        case "unlink":
          return encodeId(delta.edge.from);
      }
    });
    expect(filtered).toEqual(
      expect.arrayContaining([
        encodeId(unselectedSchema),
        encodeId(unselectedTable),
        encodeId(customRole),
        encodeId(customExtension),
        encodeId(customPublication),
        encodeId(customFdw),
      ]),
    );
    expect(filtered).not.toContain(encodeId(platformTable));
    expect(
      generated.projectionAudit?.entries.some(
        (entry) =>
          entry.delta.verb === "add" && encodeId(entry.delta.fact.id) === encodeId(platformTable),
      ),
    ).toBe(true);
  });

  it.effect("constructs the real adapter from supported public pg-delta subpaths", () =>
    Effect.gen(function* () {
      const adapter = yield* LegacyPgDeltaNextAdapter;
      expect(adapter.diff).toBeTypeOf("function");
      expect(adapter.exportDeclarativeSchema).toBeTypeOf("function");
      expect(adapter.planDeclarativeSchema).toBeTypeOf("function");
      expect(adapter.captureSnapshot).toBeTypeOf("function");
    }).pipe(Effect.provide(legacyPgDeltaNextAdapterLayer)),
  );

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
          redactSecrets: false,
          restrictToApplier: true,
          schema: ["public"],
          formatOptions: '{"keywordCase":"upper","indent":4}',
        });

        expect(state.resolveCalls).toEqual([
          {
            pool: sourcePool,
            options: { redactSecrets: false, restrictToApplier: true },
            schema: ["public"],
          },
        ]);
        expect(state.extractCalls).toEqual([
          { pool: sourcePool, options: { redactSecrets: false } },
          { pool: desiredPool, options: { redactSecrets: false } },
        ]);
        expect(state.planCalls).toEqual([
          {
            source: { id: "source-facts" },
            desired: { id: "desired-facts" },
            options: { redactSecrets: false, managedView: "shared-profile-options" },
          },
        ]);
        expect(state.renderOptions).toEqual([{ allowDrops: true }]);
        expect(result.files).toEqual([
          {
            sequence: 1,
            suffix: "_1",
            sql: "CREATE TABLE public.widgets (\n    id           integer,\n    display_name text\n);\n",
            transactionMode: "transactional",
            actionCount: 2,
          },
          {
            sequence: 2,
            suffix: "_2",
            sql: "-- pg-delta: transaction=false\nSET check_function_bodies = off;\n\nGRANT SELECT ON TABLE public.widgets TO anon;\n\nRESET ALL;\n",
            transactionMode: "none",
            actionCount: 1,
          },
        ]);
        expect(result.sql).toBe(
          "CREATE TABLE public.widgets (\n    id           integer,\n    display_name text\n);\n\n\n-- pg-delta: transaction=false\nSET check_function_bodies = off;\n\nGRANT SELECT ON TABLE public.widgets TO anon;\n\nRESET ALL;\n",
        );
        expect(result.diagnostics).toEqual([
          {
            origin: "source",
            code: "source-warning",
            severity: "warning",
            subject: "subject:s",
            message: "source-warning message",
            context: { detail: "source-warning" },
          },
          {
            origin: "desired",
            code: "desired-warning",
            severity: "warning",
            subject: "subject:d",
            message: "desired-warning message",
            context: { detail: "desired-warning" },
          },
        ]);
        expect(result.debug).toEqual({
          sourceSnapshot: expect.stringContaining("source-facts"),
          desiredSnapshot: expect.stringContaining("desired-facts"),
          plan: JSON.stringify({ source: "source-facts", desired: "desired-facts" }),
        });
        expect(state.snapshotMetadata).toEqual([
          { pgVersion: "15.9", redactSecrets: false, profile: "supabase" },
          { pgVersion: "17.6", redactSecrets: false, profile: "supabase" },
        ]);
        expect(sourcePool.ending).toBe(false);
        expect(sourcePool.ended).toBe(false);
        expect(desiredPool.ending).toBe(false);
        expect(desiredPool.ended).toBe(false);
        yield* Effect.promise(() => Promise.all([sourcePool.end(), desiredPool.end()]));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("preserves a no-change result without creating debug artifacts", () => {
    const sourcePool = new Pool();
    const desiredPool = new Pool();
    const { layer, state } = setupLibraries(sourcePool, desiredPool);
    state.renderChanges = false;

    return Effect.gen(function* () {
      const adapter = yield* LegacyPgDeltaNextAdapter;
      const result = yield* adapter.diff({
        sourcePool,
        desiredPool,
        allowDrops: false,
        debug: false,
      });
      expect(result.changes).toBe(false);
      expect(result.sql).toBe("");
      expect(result.files).toEqual([]);
      expect(result.debug).toBeUndefined();
      expect(state.snapshotMetadata).toEqual([]);
      expect(state.renderOptions).toEqual([{ allowDrops: false }]);
      yield* Effect.promise(() => Promise.all([sourcePool.end(), desiredPool.end()]));
    }).pipe(Effect.provide(layer));
  });

  it.effect("formats rendered migration files with the human-readable defaults", () => {
    const sourcePool = new Pool();
    const desiredPool = new Pool();
    const { layer } = setupLibraries(sourcePool, desiredPool);

    return Effect.gen(function* () {
      const adapter = yield* LegacyPgDeltaNextAdapter;
      const result = yield* adapter.diff({
        sourcePool,
        desiredPool,
        allowDrops: false,
        debug: false,
      });
      expect(result.files[0]?.sql).toBe(
        "create table public.widgets (\n  id           integer,\n  display_name text\n);\n",
      );
      expect(result.files[1]?.sql).toBe(
        "-- pg-delta: transaction=false\nset check_function_bodies = off;\n\ngrant select on table public.widgets to anon;\n\nreset all;\n",
      );
      yield* Effect.promise(() => Promise.all([sourcePool.end(), desiredPool.end()]));
    }).pipe(Effect.provide(layer));
  });

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
          layout: "grouped",
          restrictToApplier: true,
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
          resolveOptions: { restrictToApplier: true },
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
          layout: "grouped",
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
          isolatedShadow: true,
          seedAssumedSchemas: true,
          formatOptions: "null",
        });
        expect(state.declarativeInputs).toHaveLength(1);
        expect(state.declarativeInputs[0]).toMatchObject({
          reorder: true,
          seedAssumedSchemas: true,
        });
        expect(planned.diagnostics.map((diagnostic) => diagnostic.origin)).toEqual([
          "declarativeLoad",
          "declarativeTarget",
        ]);
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

  it.effect("captures a v2 snapshot with a single baseline-free profile resolution", () => {
    const pool = new Pool();
    const unusedDesiredPool = new Pool();
    const { layer, state } = setupLibraries(pool, unusedDesiredPool);

    return Effect.gen(function* () {
      const adapter = yield* LegacyPgDeltaNextAdapter;
      const result = yield* adapter.captureSnapshot({
        pool,
        statementTimeoutMs: 4_000,
      });
      expect(result.generation).toBe("v2");
      expect(result.pgVersion).toBe("15.9");
      expect(result.snapshot).toContain("source-facts");
      expect(state.resolveCalls).toEqual([
        {
          pool,
          options: { redactSecrets: true, skipBaseline: true },
        },
      ]);
      expect(state.extractCalls).toEqual([
        {
          pool,
          options: { redactSecrets: true, statementTimeoutMs: 4_000 },
        },
      ]);
      yield* Effect.promise(() => Promise.all([pool.end(), unusedDesiredPool.end()]));
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps library rejections to an actionable typed error", () => {
    const sourcePool = new Pool();
    const desiredPool = new Pool();
    const cause = new Error("connection refused for desired database");
    const failingLayer = legacyPgDeltaNextAdapterLayerFromLibraries({
      resolveProfile: async () => {
        throw cause;
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
        skipped: [],
      }),
      serializeSnapshot: () => "unused",
      serializePlan: () => "unused",
      summarizeRemovals: () => ({ extensions: [], extensionIntents: [] }),
      encodeSubject: (subject: string) => subject,
    });

    return Effect.gen(function* () {
      const adapter = yield* LegacyPgDeltaNextAdapter;
      const error = yield* adapter
        .diff({ sourcePool, desiredPool, allowDrops: false, debug: false })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(LegacyPgDeltaNextError);
      expect(error.operation).toBe("diff");
      expect(error.message).toBe("Database diff failed: connection refused for desired database");
      expect(error.cause).toBe(cause);
      yield* Effect.promise(() => Promise.all([sourcePool.end(), desiredPool.end()]));
    }).pipe(Effect.provide(failingLayer));
  });

  it.effect("preserves shadow-load diagnostics in the actionable error", () => {
    const targetPool = new Pool();
    const shadowPool = new Pool();
    const cause = new ShadowLoadError("2 files cannot apply", [
      {
        code: "stuck_statement",
        severity: "error",
        message: 'extensions/pg_cron.sql: extension "pg_cron" already exists',
      },
      {
        code: "stuck_statement",
        severity: "error",
        message: 'extensions/pg_net.sql: extension "pg_net" already exists',
      },
    ]);
    const failingLayer = legacyPgDeltaNextAdapterLayerFromLibraries({
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
      planSchemaFiles: async () => {
        throw cause;
      },
      serializeSnapshot: () => "unused",
      serializePlan: () => "unused",
      summarizeRemovals: () => ({ extensions: [], extensionIntents: [] }),
      encodeSubject: (subject: string) => subject,
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
          isolatedShadow: true,
          seedAssumedSchemas: false,
        })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(LegacyPgDeltaNextError);
      expect(error.message).toBe(
        'Declarative schema planning failed: 2 files cannot apply\n  - extensions/pg_cron.sql: extension "pg_cron" already exists\n  - extensions/pg_net.sql: extension "pg_net" already exists',
      );
      expect(error.cause).toBe(cause);
      yield* Effect.promise(() => Promise.all([targetPool.end(), shadowPool.end()]));
    }).pipe(Effect.provide(failingLayer));
  });
});
