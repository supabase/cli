import { it } from "@effect/vitest";
import { ShadowLoadError } from "@supabase/pg-delta/frontends";
import { Effect } from "effect";
import { Pool } from "pg";
import { describe, expect } from "vitest";

import {
  legacyPgDeltaNextAdapterLayer,
  legacyPgDeltaNextAdapterLayerFromLibraries,
  legacyFilterPgDeltaNextPlatformParameterAclDiagnostics,
  legacyPgDeltaNextProfile,
  legacyPgDeltaNextUserOwnedParameterAcls,
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
    renderAllowDrops: [] as boolean[],
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
    renderPlanFiles: (generatedPlan, options) => {
      state.renderAllowDrops.push(options.allowDrops);
      if (!state.renderChanges) return { changes: false, files: [] };
      return {
        changes: true,
        files: [
          {
            suffix: "_1",
            contents: `begin ${generatedPlan.source};\n`,
            transactional: true,
            actionCount: 2,
          },
          {
            suffix: "_2",
            contents: `alter ${generatedPlan.desired};\n`,
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
    encodeSubject: (subject) => `subject:${subject.id}`,
  };

  return {
    state,
    layer: legacyPgDeltaNextAdapterLayerFromLibraries(libraries),
  };
}

describe("LegacyPgDeltaNextAdapter", () => {
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

  it("composes schema exclusions ahead of the Supabase managed-view policy", () => {
    const profile = legacyPgDeltaNextProfile(["public", "tenant"]);
    expect(profile.id).toBe("supabase");
    expect(profile.policy?.filter).toEqual([
      {
        match: { all: [{ schema: "*" }, { not: { schema: ["public", "tenant"] } }] },
        action: "exclude",
      },
      {
        match: {
          all: [{ kind: "schema" }, { not: { name: ["public", "tenant"] } }],
        },
        action: "exclude",
      },
      {
        match: {
          all: [{ target: { schema: "*" } }, { not: { target: { schema: ["public", "tenant"] } } }],
        },
        action: "exclude",
      },
    ]);
    expect(profile.policy?.extends).toHaveLength(1);
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
        expect(result.files).toEqual([
          {
            sequence: 1,
            suffix: "_1",
            sql: "begin source-facts;\n",
            transactionMode: "transactional",
            actionCount: 2,
          },
          {
            sequence: 2,
            suffix: "_2",
            sql: "alter desired-facts;\n",
            transactionMode: "none",
            actionCount: 1,
          },
        ]);
        expect(result.sql).toBe("begin source-facts;\n\n\nalter desired-facts;\n");
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
      expect(state.renderAllowDrops).toEqual([false]);
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

        const planned = yield* adapter.planDeclarativeSchema({
          targetPool,
          shadowPool,
          files: exported.files,
          allowDrops: true,
          debug: true,
          isolatedShadow: true,
          seedAssumedSchemas: true,
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
        expect(planned.debug).toEqual({
          plan: JSON.stringify({ source: "target-facts", desired: "loaded-files" }),
        });
        expect(state.renderAllowDrops).toEqual([true]);
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
