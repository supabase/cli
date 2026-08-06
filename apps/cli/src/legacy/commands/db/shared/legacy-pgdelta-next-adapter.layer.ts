import { Effect, Layer } from "effect";
import type { Pool } from "pg";
import { serializeSnapshot, encodeId } from "@supabase/pg-delta/core";
import { buildSchemaExport, planSchemaFiles, renderPlanFiles } from "@supabase/pg-delta/frontends";
import {
  type IntegrationProfile,
  resolveProfile,
  supabaseProfile,
} from "@supabase/pg-delta/integrations";
import { plan, serializePlan } from "@supabase/pg-delta/plan";
import type { Policy } from "@supabase/pg-delta/policy";
import type { SqlFormatOptions } from "@supabase/pg-delta/sql-format";

import {
  LegacyPgDeltaNextAdapter,
  LegacyPgDeltaNextError,
  type LegacyPgDeltaNextAdapterShape,
  type LegacyPgDeltaNextDeclarativeExportInput,
  type LegacyPgDeltaNextDeclarativeManifestInput,
  type LegacyPgDeltaNextDeclarativePlanInput,
  type LegacyPgDeltaNextDiagnostic,
  type LegacyPgDeltaNextDiagnosticOrigin,
  type LegacyPgDeltaNextDiffInput,
  type LegacyPgDeltaNextExportManifest,
  type LegacyPgDeltaNextRenderedFile,
  type LegacyPgDeltaNextSnapshotCaptureInput,
  type LegacyPgDeltaNextSqlFile,
  type LegacyPgDeltaNextOperation,
} from "./legacy-pgdelta-next-adapter.service.ts";

interface LegacyPgDeltaNextLibraryDiagnostic<Subject> {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly subject?: Subject;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

interface LegacyPgDeltaNextLibraryExtractResult<FactBase, Subject> {
  readonly factBase: FactBase;
  readonly pgVersion: string;
  readonly diagnostics: readonly LegacyPgDeltaNextLibraryDiagnostic<Subject>[];
}

interface LegacyPgDeltaNextResolvedProfile<FactBase, PlanOptions extends object, Subject> {
  readonly id: string;
  readonly planOptions: PlanOptions;
  readonly extract: (
    pool: Pool,
    options?: { readonly redactSecrets?: boolean; readonly statementTimeoutMs?: number },
  ) => Promise<LegacyPgDeltaNextLibraryExtractResult<FactBase, Subject>>;
}

interface LegacyPgDeltaNextLibraryRenderedFile {
  readonly suffix: string | null;
  readonly contents: string;
  readonly transactional: boolean;
  readonly actionCount: number;
}

interface LegacyPgDeltaNextLibraryRenderedResult {
  readonly changes: boolean;
  readonly files: readonly LegacyPgDeltaNextLibraryRenderedFile[];
}

interface LegacyPgDeltaNextLibrarySchemaExport<Subject> {
  readonly files: readonly LegacyPgDeltaNextSqlFile[];
  readonly diagnostics: readonly LegacyPgDeltaNextLibraryDiagnostic<Subject>[];
  readonly manifest: LegacyPgDeltaNextExportManifest;
}

type LegacyPgDeltaNextLibraryExportOptions = ReturnType<typeof legacyPgDeltaNextExportOptions>;

interface LegacyPgDeltaNextLibrarySchemaPlan<Plan, Subject> {
  readonly plan: Plan;
  readonly loadDiagnostics: readonly LegacyPgDeltaNextLibraryDiagnostic<Subject>[];
  readonly targetDiagnostics: readonly LegacyPgDeltaNextLibraryDiagnostic<Subject>[];
  readonly skipped: readonly { readonly file: string; readonly stmt: string }[];
}

export interface LegacyPgDeltaNextLibraries<FactBase, PlanOptions extends object, Plan, Subject> {
  readonly resolveProfile: (
    pool: Pool,
    options: {
      readonly restrictToApplier?: boolean;
      readonly redactSecrets?: boolean;
      readonly skipBaseline?: boolean;
    },
    schema?: readonly string[],
  ) => Promise<LegacyPgDeltaNextResolvedProfile<FactBase, PlanOptions, Subject>>;
  readonly plan: (
    source: FactBase,
    desired: FactBase,
    options: PlanOptions & { readonly redactSecrets: boolean },
  ) => Plan;
  readonly renderPlanFiles: (
    plan: Plan,
    options: { readonly allowDrops: boolean },
  ) => LegacyPgDeltaNextLibraryRenderedResult;
  readonly buildSchemaExport: (
    pool: Pool,
    input: LegacyPgDeltaNextLibraryExportOptions,
  ) => Promise<LegacyPgDeltaNextLibrarySchemaExport<Subject>>;
  readonly planSchemaFiles: (
    targetPool: Pool,
    shadowPool: Pool,
    files: readonly LegacyPgDeltaNextSqlFile[],
    input: LegacyPgDeltaNextDeclarativePlanInput,
  ) => Promise<LegacyPgDeltaNextLibrarySchemaPlan<Plan, Subject>>;
  readonly serializeSnapshot: (
    factBase: FactBase,
    metadata: {
      readonly pgVersion: string;
      readonly redactSecrets: boolean;
      readonly profile: string;
    },
  ) => string;
  readonly serializePlan: (plan: Plan) => string;
  readonly encodeSubject: (subject: Subject) => string;
}

function legacyPgDeltaNextMessage(operation: LegacyPgDeltaNextOperation, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const label =
    operation === "declarativeExport"
      ? "Declarative schema export"
      : operation === "declarativePlan"
        ? "Declarative schema planning"
        : operation === "snapshotCapture"
          ? "Snapshot capture"
          : "Database diff";
  return `${label} failed: ${detail}`;
}

function legacyTryPgDeltaNext<Success>(
  operation: LegacyPgDeltaNextOperation,
  run: () => Promise<Success>,
) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new LegacyPgDeltaNextError({
        operation,
        message: legacyPgDeltaNextMessage(operation, cause),
        cause,
      }),
  });
}

function legacyNormalizePgDeltaNextDiagnostics<Subject>(
  diagnostics: readonly LegacyPgDeltaNextLibraryDiagnostic<Subject>[],
  origin: LegacyPgDeltaNextDiagnosticOrigin,
  encodeSubject: (subject: Subject) => string,
): LegacyPgDeltaNextDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    origin,
    code: diagnostic.code,
    severity: diagnostic.severity,
    ...(diagnostic.subject !== undefined ? { subject: encodeSubject(diagnostic.subject) } : {}),
    message: diagnostic.message,
    ...(diagnostic.context !== undefined ? { context: diagnostic.context } : {}),
  }));
}

function legacyIsPgDeltaNextParameterAclDiagnostic<Subject>(
  diagnostic: LegacyPgDeltaNextLibraryDiagnostic<Subject>,
): boolean {
  return diagnostic.code === "unmodeled_kind" && diagnostic.context?.["kind"] === "parameter ACL";
}

/**
 * The parameter-ACL catalog is cluster-wide, so a co-located declarative shadow
 * observes Supabase platform grants too. Keep strict coverage for every ACL
 * other than the exact platform bootstrap grant while removing the aggregate
 * diagnostic when that bootstrap grant is the only observed parameter ACL.
 */
export function legacyFilterPgDeltaNextPlatformParameterAclDiagnostics<Subject>(
  diagnostics: readonly LegacyPgDeltaNextLibraryDiagnostic<Subject>[],
  userOwnedParameterAcls: readonly string[],
): LegacyPgDeltaNextLibraryDiagnostic<Subject>[] {
  const names = [...new Set(userOwnedParameterAcls)].sort();
  const filtered: LegacyPgDeltaNextLibraryDiagnostic<Subject>[] = [];
  for (const diagnostic of diagnostics) {
    if (!legacyIsPgDeltaNextParameterAclDiagnostic(diagnostic)) {
      filtered.push(diagnostic);
      continue;
    }
    if (names.length === 0) continue;
    const samples = names.slice(0, 5);
    const more = names.length > samples.length ? ", …" : "";
    filtered.push({
      ...diagnostic,
      message:
        `${names.length} unmodeled "parameter ACL" object${names.length === 1 ? "" : "s"} ` +
        `not managed by this engine (e.g. ${samples.join(", ")}${more}) — ` +
        "v1 detects but does not model this kind",
      context: { kind: "parameter ACL", count: names.length, samples },
    });
  }
  return filtered;
}

interface LegacyPgDeltaNextParameterAclGrant {
  readonly name: string;
  readonly grantee: string;
  readonly privilege: string;
}

// Supabase's platform bootstrap grants these so privileged platform roles can
// manage the setting and the Realtime owner can replay routines whose proconfig
// contains `SET log_min_messages ...`. Parameter ACLs have cluster scope, so
// the grants are also visible from sibling shadow DBs.
const legacyPgDeltaNextPlatformParameterAcls = new Set([
  "log_min_messages\u0000supabase_admin\u0000ALTER SYSTEM",
  "log_min_messages\u0000supabase_admin\u0000SET",
  "log_min_messages\u0000supabase_realtime_admin\u0000SET",
]);

function legacyPgDeltaNextParameterAclKey(grant: LegacyPgDeltaNextParameterAclGrant): string {
  return `${grant.name}\u0000${grant.grantee}\u0000${grant.privilege}`;
}

export function legacyPgDeltaNextUserOwnedParameterAcls(
  grants: readonly LegacyPgDeltaNextParameterAclGrant[],
): string[] {
  return [
    ...new Set(
      grants
        .filter(
          (grant) =>
            !legacyPgDeltaNextPlatformParameterAcls.has(legacyPgDeltaNextParameterAclKey(grant)),
        )
        .map((grant) => grant.name),
    ),
  ].sort();
}

async function legacyFilterPgDeltaNextPlatformDiagnostics<Subject>(
  pool: Pool,
  diagnostics: readonly LegacyPgDeltaNextLibraryDiagnostic<Subject>[],
): Promise<LegacyPgDeltaNextLibraryDiagnostic<Subject>[]> {
  if (!diagnostics.some(legacyIsPgDeltaNextParameterAclDiagnostic)) return [...diagnostics];
  const result = await pool.query<LegacyPgDeltaNextParameterAclGrant>(
    `SELECT DISTINCT pa.parname AS name,
                     COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
                     acl.privilege_type AS privilege
       FROM pg_parameter_acl pa
       CROSS JOIN LATERAL aclexplode(pa.paracl) acl
       LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
      ORDER BY pa.parname, grantee, privilege`,
  );
  return legacyFilterPgDeltaNextPlatformParameterAclDiagnostics(
    diagnostics,
    legacyPgDeltaNextUserOwnedParameterAcls(result.rows),
  );
}

function legacyNormalizePgDeltaNextRenderedFiles(
  files: readonly LegacyPgDeltaNextLibraryRenderedFile[],
): LegacyPgDeltaNextRenderedFile[] {
  return files.map((file, index) => ({
    sequence: index + 1,
    suffix: file.suffix,
    sql: file.contents,
    transactional: file.transactional,
    actionCount: file.actionCount,
  }));
}

export function legacyPgDeltaNextProfile(
  schema: readonly string[] | undefined,
): IntegrationProfile {
  if (schema === undefined || schema.length === 0 || supabaseProfile.policy === undefined) {
    return supabaseProfile;
  }
  const selected = [...schema];
  const policy: Policy = {
    id: `supabase-cli-schemas:${selected.join(",")}`,
    filter: [
      {
        match: { all: [{ schema: "*" }, { not: { schema: selected } }] },
        action: "exclude",
      },
      {
        match: { all: [{ kind: "schema" }, { not: { name: selected } }] },
        action: "exclude",
      },
      {
        match: {
          all: [{ target: { schema: "*" } }, { not: { target: { schema: selected } } }],
        },
        action: "exclude",
      },
    ],
    extends: [supabaseProfile.policy],
  };
  return { ...supabaseProfile, policy };
}

function legacyPgDeltaNextFormatOptions(raw: string | undefined): SqlFormatOptions | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const value = (key: string): unknown => Reflect.get(parsed, key);
  const keywordCase = value("keywordCase");
  const commaStyle = value("commaStyle");
  const indent = value("indent");
  const maxWidth = value("maxWidth");
  const alignColumns = value("alignColumns");
  const alignKeyValues = value("alignKeyValues");
  const preserveRoutineBodies = value("preserveRoutineBodies");
  const preserveViewBodies = value("preserveViewBodies");
  const preserveRuleBodies = value("preserveRuleBodies");
  return {
    ...(keywordCase === "upper" || keywordCase === "lower" || keywordCase === "preserve"
      ? { keywordCase }
      : {}),
    ...(commaStyle === "trailing" || commaStyle === "leading" ? { commaStyle } : {}),
    ...(typeof indent === "number" ? { indent } : {}),
    ...(typeof maxWidth === "number" ? { maxWidth } : {}),
    ...(typeof alignColumns === "boolean" ? { alignColumns } : {}),
    ...(typeof alignKeyValues === "boolean" ? { alignKeyValues } : {}),
    ...(typeof preserveRoutineBodies === "boolean" ? { preserveRoutineBodies } : {}),
    ...(typeof preserveViewBodies === "boolean" ? { preserveViewBodies } : {}),
    ...(typeof preserveRuleBodies === "boolean" ? { preserveRuleBodies } : {}),
  };
}

function legacyPgDeltaNextExportOptions(input: LegacyPgDeltaNextDeclarativeExportInput) {
  const format = legacyPgDeltaNextFormatOptions(input.formatOptions);
  return {
    profile: legacyPgDeltaNextProfile(input.schema),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.redactSecrets !== undefined ? { redactSecrets: input.redactSecrets } : {}),
    ...(input.restrictToApplier !== undefined
      ? { resolveOptions: { restrictToApplier: input.restrictToApplier } }
      : {}),
    ...(input.layout !== undefined ? { layout: input.layout } : {}),
    ...(input.grouping !== undefined
      ? {
          grouping: {
            ...(input.grouping.mode !== undefined ? { mode: input.grouping.mode } : {}),
            ...(input.grouping.groupPatterns !== undefined
              ? { groupPatterns: [...input.grouping.groupPatterns] }
              : {}),
            ...(input.grouping.flatSchemas !== undefined
              ? { flatSchemas: [...input.grouping.flatSchemas] }
              : {}),
            ...(input.grouping.autoGroupPartitions !== undefined
              ? { autoGroupPartitions: input.grouping.autoGroupPartitions }
              : {}),
          },
        }
      : {}),
    ...(input.defaultOwner !== undefined ? { defaultOwner: input.defaultOwner } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(input.onWarning !== undefined ? { onWarning: input.onWarning } : {}),
  };
}

function legacyPgDeltaNextManifest(manifest: LegacyPgDeltaNextDeclarativeManifestInput) {
  return {
    ...(manifest.redactSecrets !== undefined ? { redactSecrets: manifest.redactSecrets } : {}),
    ...(manifest.profile !== undefined ? { profile: manifest.profile } : {}),
    ...(manifest.scope !== undefined ? { scope: manifest.scope } : {}),
    ...(manifest.baselineDigest !== undefined ? { baselineDigest: manifest.baselineDigest } : {}),
    ...(manifest.defaultOwner !== undefined ? { defaultOwner: manifest.defaultOwner } : {}),
    ...(manifest.files !== undefined ? { files: [...manifest.files] } : {}),
  };
}

function legacyPgDeltaNextPlanOptions(input: LegacyPgDeltaNextDeclarativePlanInput) {
  return {
    profile: legacyPgDeltaNextProfile(input.schema),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.manifest !== undefined
      ? { manifest: legacyPgDeltaNextManifest(input.manifest) }
      : {}),
    ...(input.redactSecrets !== undefined ? { redactSecrets: input.redactSecrets } : {}),
    ...(input.skipClusterDdl !== undefined ? { skipClusterDdl: input.skipClusterDdl } : {}),
    ...(input.isolatedShadow !== undefined ? { isolatedShadow: input.isolatedShadow } : {}),
    ...(input.seedAssumedSchemas !== undefined
      ? { seedAssumedSchemas: input.seedAssumedSchemas }
      : {}),
    ...(input.restrictToApplier !== undefined
      ? { resolveOptions: { restrictToApplier: input.restrictToApplier } }
      : {}),
    ...(input.strictFunctionBodies !== undefined
      ? { strictFunctionBodies: input.strictFunctionBodies }
      : {}),
    reorder: input.reorder ?? true,
    ...(input.onWarning !== undefined ? { onWarning: input.onWarning } : {}),
  };
}

function legacyMakePgDeltaNextAdapter<FactBase, PlanOptions extends object, Plan, Subject>(
  libraries: LegacyPgDeltaNextLibraries<FactBase, PlanOptions, Plan, Subject>,
): LegacyPgDeltaNextAdapterShape {
  return {
    diff: (input: LegacyPgDeltaNextDiffInput) =>
      legacyTryPgDeltaNext("diff", async () => {
        const redactSecrets = input.redactSecrets ?? true;
        const profile = await libraries.resolveProfile(
          input.sourcePool,
          {
            redactSecrets,
            ...(input.restrictToApplier !== undefined
              ? { restrictToApplier: input.restrictToApplier }
              : {}),
          },
          input.schema,
        );
        const [source, desired] = await Promise.all([
          profile.extract(input.sourcePool, { redactSecrets }),
          profile.extract(input.desiredPool, { redactSecrets }),
        ]);
        const generatedPlan = libraries.plan(source.factBase, desired.factBase, {
          ...profile.planOptions,
          redactSecrets,
        });
        const rendered = libraries.renderPlanFiles(generatedPlan, {
          allowDrops: input.allowDrops,
        });
        const diagnostics = [
          ...legacyNormalizePgDeltaNextDiagnostics(
            source.diagnostics,
            "source",
            libraries.encodeSubject,
          ),
          ...legacyNormalizePgDeltaNextDiagnostics(
            desired.diagnostics,
            "desired",
            libraries.encodeSubject,
          ),
        ];
        return {
          changes: rendered.changes,
          sql: rendered.files.map((file) => file.contents).join("\n\n"),
          files: legacyNormalizePgDeltaNextRenderedFiles(rendered.files),
          diagnostics,
          ...(input.debug
            ? {
                debug: {
                  sourceSnapshot: libraries.serializeSnapshot(source.factBase, {
                    pgVersion: source.pgVersion,
                    redactSecrets,
                    profile: profile.id,
                  }),
                  desiredSnapshot: libraries.serializeSnapshot(desired.factBase, {
                    pgVersion: desired.pgVersion,
                    redactSecrets,
                    profile: profile.id,
                  }),
                  plan: libraries.serializePlan(generatedPlan),
                },
              }
            : {}),
        };
      }),
    exportDeclarativeSchema: (input: LegacyPgDeltaNextDeclarativeExportInput) =>
      legacyTryPgDeltaNext("declarativeExport", async () => {
        const result = await libraries.buildSchemaExport(
          input.pool,
          legacyPgDeltaNextExportOptions(input),
        );
        return {
          files: result.files.map((file) => ({ name: file.name, sql: file.sql })),
          manifest: {
            ...result.manifest,
            files: result.files.map((file) => file.name).sort(),
          },
          diagnostics: legacyNormalizePgDeltaNextDiagnostics(
            result.diagnostics,
            "export",
            libraries.encodeSubject,
          ),
        };
      }),
    planDeclarativeSchema: (input: LegacyPgDeltaNextDeclarativePlanInput) =>
      legacyTryPgDeltaNext("declarativePlan", async () => {
        const planningInput = { ...input, reorder: input.reorder ?? true };
        const result = await libraries.planSchemaFiles(
          input.targetPool,
          input.shadowPool,
          input.files,
          planningInput,
        );
        const rendered = libraries.renderPlanFiles(result.plan, {
          allowDrops: input.allowDrops,
        });
        return {
          changes: rendered.changes,
          sql: rendered.files.map((file) => file.contents).join("\n\n"),
          files: legacyNormalizePgDeltaNextRenderedFiles(rendered.files),
          diagnostics: [
            ...legacyNormalizePgDeltaNextDiagnostics(
              result.loadDiagnostics,
              "declarativeLoad",
              libraries.encodeSubject,
            ),
            ...legacyNormalizePgDeltaNextDiagnostics(
              result.targetDiagnostics,
              "declarativeTarget",
              libraries.encodeSubject,
            ),
          ],
          skipped: result.skipped.map((skipped) => ({
            file: skipped.file,
            statement: skipped.stmt,
          })),
          ...(input.debug ? { debug: { plan: libraries.serializePlan(result.plan) } } : {}),
        };
      }),
    captureSnapshot: (input: LegacyPgDeltaNextSnapshotCaptureInput) =>
      legacyTryPgDeltaNext("snapshotCapture", async () => {
        const redactSecrets = input.redactSecrets ?? true;
        const profile = await libraries.resolveProfile(input.pool, {
          redactSecrets,
          skipBaseline: true,
        });
        const result = await profile.extract(input.pool, {
          redactSecrets,
          ...(input.statementTimeoutMs !== undefined
            ? { statementTimeoutMs: input.statementTimeoutMs }
            : {}),
        });
        return {
          generation: "v2",
          snapshot: libraries.serializeSnapshot(result.factBase, {
            pgVersion: result.pgVersion,
            redactSecrets,
            profile: profile.id,
          }),
          pgVersion: result.pgVersion,
          diagnostics: legacyNormalizePgDeltaNextDiagnostics(
            result.diagnostics,
            "snapshot",
            libraries.encodeSubject,
          ),
        };
      }),
  };
}

const legacyPgDeltaNextRealLibraries = {
  resolveProfile: async (
    pool: Pool,
    options: Parameters<typeof resolveProfile>[2],
    schema?: readonly string[],
  ) => {
    const resolved = await resolveProfile(pool, legacyPgDeltaNextProfile(schema), options);
    return {
      ...resolved,
      extract: async (
        extractPool: Pool,
        extractOptions?: Parameters<typeof resolved.extract>[1],
      ) => {
        const result = await resolved.extract(extractPool, extractOptions);
        return {
          ...result,
          diagnostics: await legacyFilterPgDeltaNextPlatformDiagnostics(
            extractPool,
            result.diagnostics,
          ),
        };
      },
    };
  },
  plan,
  renderPlanFiles,
  buildSchemaExport: async (pool: Pool, input: LegacyPgDeltaNextLibraryExportOptions) => {
    const result = await buildSchemaExport(pool, input);
    return {
      ...result,
      diagnostics: await legacyFilterPgDeltaNextPlatformDiagnostics(pool, result.diagnostics),
    };
  },
  planSchemaFiles: async (
    targetPool: Pool,
    shadowPool: Pool,
    files: readonly LegacyPgDeltaNextSqlFile[],
    input: LegacyPgDeltaNextDeclarativePlanInput,
  ) => {
    const result = await planSchemaFiles(
      targetPool,
      shadowPool,
      files.map((file) => ({ name: file.name, sql: file.sql })),
      legacyPgDeltaNextPlanOptions(input),
    );
    const [loadDiagnostics, targetDiagnostics] = await Promise.all([
      legacyFilterPgDeltaNextPlatformDiagnostics(shadowPool, result.loadDiagnostics),
      legacyFilterPgDeltaNextPlatformDiagnostics(targetPool, result.targetDiagnostics),
    ]);
    return { ...result, loadDiagnostics, targetDiagnostics };
  },
  serializeSnapshot,
  serializePlan,
  encodeSubject: encodeId,
};

export function legacyPgDeltaNextAdapterLayerFromLibraries<
  FactBase,
  PlanOptions extends object,
  Plan,
  Subject,
>(libraries: LegacyPgDeltaNextLibraries<FactBase, PlanOptions, Plan, Subject>) {
  return Layer.succeed(
    LegacyPgDeltaNextAdapter,
    LegacyPgDeltaNextAdapter.of(legacyMakePgDeltaNextAdapter(libraries)),
  );
}

export const legacyPgDeltaNextAdapterLayer = legacyPgDeltaNextAdapterLayerFromLibraries(
  legacyPgDeltaNextRealLibraries,
);
