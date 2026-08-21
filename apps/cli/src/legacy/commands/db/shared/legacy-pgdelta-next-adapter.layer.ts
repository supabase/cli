import { Effect, Layer } from "effect";
import type { Pool } from "pg";
import {
  serializeSnapshot,
  encodeId,
  type Diagnostic as PgDeltaDiagnostic,
} from "@supabase/pg-delta/core";
import {
  buildSchemaExport,
  dataLossActions,
  planSchemaFiles,
  renderPlanFiles,
  ShadowLoadError,
} from "@supabase/pg-delta/frontends";
import {
  type IntegrationProfile,
  resolveProfile,
  supabaseProfile,
} from "@supabase/pg-delta/integrations";
import { classifyPlanHazards, plan, serializePlan } from "@supabase/pg-delta/plan";
import type { Plan as PgDeltaPlan } from "@supabase/pg-delta/plan";
import type { Policy } from "@supabase/pg-delta/policy";
import type { SqlFormatOptions } from "@supabase/pg-delta/sql-format";
import { schemaIsolatedPlanOptions } from "../../../../shared/schema/schema-plan-options.ts";
import {
  formatSchemaSql,
  SCHEMA_SQL_FORMAT_DEFAULTS,
} from "../../../../shared/schema/sql-format-defaults.ts";

import {
  LegacyPgDeltaNextAdapter,
  LegacyPgDeltaNextError,
  type LegacyPgDeltaNextAdapterShape,
  type LegacyPgDeltaNextDeclarativeExportInput,
  type LegacyPgDeltaNextDeclarativePlanInput,
  type LegacyPgDeltaNextDiagnostic,
  type LegacyPgDeltaNextDiagnosticOrigin,
  type LegacyPgDeltaNextDiffInput,
  type LegacyPgDeltaNextExportManifest,
  type LegacyPgDeltaNextHazardReport,
  type LegacyPgDeltaNextRenderedFile,
  type LegacyPgDeltaNextSnapshotCaptureInput,
  type LegacyPgDeltaNextSqlFile,
  type LegacyPgDeltaNextOperation,
} from "./legacy-pgdelta-next-adapter.service.ts";
import type {
  LegacyPgDeltaErrorDiagnostic,
  LegacyPgDeltaRemovalSummary,
} from "./legacy-pgdelta-engine.service.ts";
import { LEGACY_PG_DELTA_NEXT_SKIPPED_STATEMENT_CODE } from "./legacy-pgdelta-next-diagnostics.ts";

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
type LegacyPgDeltaNextLibraryPlanOptions = ReturnType<typeof legacyPgDeltaNextPlanOptions>;

interface LegacyPgDeltaNextLibrarySchemaPlan<Plan, Subject> {
  readonly plan: Plan;
  readonly loadDiagnostics: readonly LegacyPgDeltaNextLibraryDiagnostic<Subject>[];
  readonly targetDiagnostics: readonly LegacyPgDeltaNextLibraryDiagnostic<Subject>[];
  readonly driftDiagnostics: readonly LegacyPgDeltaNextLibraryDiagnostic<Subject>[];
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
    input: LegacyPgDeltaNextLibraryPlanOptions,
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
  readonly summarizeRemovals: (plan: Plan) => LegacyPgDeltaRemovalSummary;
  readonly summarizeHazards: (
    plan: Plan,
    diagnostics: readonly LegacyPgDeltaNextLibraryDiagnostic<Subject>[],
  ) => LegacyPgDeltaNextHazardReport;
  readonly encodeSubject: (subject: Subject) => string;
}

export function legacySummarizePgDeltaNextRemovals(
  generatedPlan: Pick<PgDeltaPlan, "deltas">,
): LegacyPgDeltaRemovalSummary {
  const extensions = new Set<string>();
  const extensionIntents = new Map<
    string,
    LegacyPgDeltaRemovalSummary["extensionIntents"][number]
  >();
  for (const delta of generatedPlan.deltas) {
    if (delta.verb !== "remove" || delta.fact.parent !== undefined) continue;
    const id = delta.fact.id;
    if (id.kind === "extension") {
      extensions.add(id.name);
      continue;
    }
    if (id.kind !== "extensionIntent") continue;
    const removal = { extension: id.ext, intentKind: id.intentKind, key: id.key };
    extensionIntents.set(`${id.ext}\u0000${id.intentKind}\u0000${id.key}`, removal);
  }
  return {
    extensions: [...extensions].sort(),
    extensionIntents: [...extensionIntents.values()].sort(
      (left, right) =>
        left.extension.localeCompare(right.extension) ||
        left.intentKind.localeCompare(right.intentKind) ||
        left.key.localeCompare(right.key),
    ),
  };
}

export function legacySummarizePgDeltaNextHazards(
  generatedPlan: Pick<PgDeltaPlan, "actions">,
  diagnostics: readonly PgDeltaDiagnostic[],
): LegacyPgDeltaNextHazardReport {
  const classified = classifyPlanHazards(generatedPlan, diagnostics);
  return {
    actions: classified.actions.map((action) => ({
      actionIndex: action.actionIndex,
      kinds: [...action.kinds],
    })),
    dataLoss: dataLossActions(generatedPlan.actions).map((action) => ({ ...action })),
    coverage: [...classified.coverage],
    kinds: [...classified.kinds],
  };
}

function legacyPgDeltaNextMessage(operation: LegacyPgDeltaNextOperation, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const diagnostics =
    cause instanceof ShadowLoadError ? cause.details.map((diagnostic) => diagnostic.message) : [];
  const label =
    operation === "declarativeExport"
      ? "Declarative schema export"
      : operation === "declarativePlan"
        ? "Declarative schema planning"
        : operation === "snapshotCapture"
          ? "Snapshot capture"
          : "Database diff";
  const renderedDiagnostics = diagnostics.map((diagnostic) => `  - ${diagnostic}`).join("\n");
  return `${label} failed: ${detail}${renderedDiagnostics === "" ? "" : `\n${renderedDiagnostics}`}`;
}

function legacyPgDeltaNextErrorDiagnostics(
  cause: unknown,
): readonly LegacyPgDeltaErrorDiagnostic[] | undefined {
  if (!(cause instanceof ShadowLoadError)) return undefined;
  return cause.details.map((diagnostic) => ({
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.context !== undefined ? { context: { ...diagnostic.context } } : {}),
  }));
}

function legacyTryPgDeltaNext<Success>(
  operation: LegacyPgDeltaNextOperation,
  run: () => Promise<Success>,
) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => {
      const diagnostics = legacyPgDeltaNextErrorDiagnostics(cause);
      return new LegacyPgDeltaNextError({
        operation,
        message: legacyPgDeltaNextMessage(operation, cause),
        cause,
        ...(diagnostics !== undefined ? { diagnostics } : {}),
      });
    },
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

/**
 * Turns `planSchemaFiles`' skipped statements into coverage diagnostics so they
 * travel the ONE diagnostic report path every consumer already renders and
 * enforces — warned by default, blocking under `--strict-coverage`. Built here,
 * where `skipped` originates, so no consumer has to remember to look at the
 * separate `skipped` field (nothing did, and the statements vanished silently).
 * The per-diagnostic message deliberately carries the raw statement verbatim:
 * it is the user's own declarative file content (already on their machine), and
 * a redacted message would leave `--strict-coverage`/debug failures
 * unactionable. The default aggregate warning still names files only.
 */
function legacySkippedStatementDiagnostics(
  skipped: readonly { readonly file: string; readonly stmt: string }[],
): LegacyPgDeltaNextDiagnostic[] {
  return skipped.map((entry) => ({
    origin: "declarativeLoad",
    code: LEGACY_PG_DELTA_NEXT_SKIPPED_STATEMENT_CODE,
    severity: "warning",
    subject: entry.file,
    message: `pg-delta could not load a declarative schema statement from ${entry.file}: ${entry.stmt}`,
    context: { file: entry.file, statement: entry.stmt },
  }));
}

function legacyNormalizePgDeltaNextRenderedFiles(
  files: readonly LegacyPgDeltaNextLibraryRenderedFile[],
): LegacyPgDeltaNextRenderedFile[] {
  return files.map((file, index) => ({
    sequence: index + 1,
    suffix: file.suffix,
    sql: file.contents,
    transactionMode: file.transactional ? "transactional" : "none",
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
        match: {
          all: [
            { verb: ["add", "remove", "set", "link", "unlink"] },
            {
              not: {
                any: [
                  { schema: selected },
                  { all: [{ kind: "schema" }, { name: selected }] },
                  { target: { schema: selected } },
                  { target: { kind: "schema", name: selected } },
                ],
              },
            },
          ],
        },
        action: "exclude",
      },
    ],
    extends: [supabaseProfile.policy],
  };
  return { ...supabaseProfile, policy };
}

function legacyPgDeltaNextFormatOptions(raw: string | undefined): SqlFormatOptions | undefined {
  if (raw === undefined || raw.trim().length === 0) return SCHEMA_SQL_FORMAT_DEFAULTS;
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null) return undefined;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return SCHEMA_SQL_FORMAT_DEFAULTS;
  }
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
    ...SCHEMA_SQL_FORMAT_DEFAULTS,
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

function legacyFormatPgDeltaNextRenderedFiles(
  files: readonly LegacyPgDeltaNextLibraryRenderedFile[],
  format: SqlFormatOptions | undefined,
): readonly LegacyPgDeltaNextLibraryRenderedFile[] {
  if (format === undefined) return files;
  return files.map((file) => ({
    ...file,
    contents: formatSchemaSql(file.contents, format),
  }));
}

function legacyPgDeltaNextExportOptions(input: LegacyPgDeltaNextDeclarativeExportInput) {
  const format = legacyPgDeltaNextFormatOptions(input.formatOptions);
  return {
    profile: legacyPgDeltaNextProfile(input.schema),
    layout: "grouped" as const,
    ...(format !== undefined ? { format } : {}),
  };
}

function legacyPgDeltaNextPlanOptions(input: LegacyPgDeltaNextDeclarativePlanInput) {
  let manifest;
  if (input.manifest !== undefined) {
    const { files, loadOrder, ...metadata } = input.manifest;
    manifest = {
      ...metadata,
      ...(files !== undefined ? { files: [...files] } : {}),
      ...(loadOrder !== undefined ? { loadOrder: [...loadOrder] } : {}),
    };
  }
  // Isolated load only — do not pin scope/redactSecrets; the sidecar owns those.
  return {
    isolatedShadow: schemaIsolatedPlanOptions.isolatedShadow,
    seedAssumedSchemas: schemaIsolatedPlanOptions.seedAssumedSchemas,
    strictDataStatements: schemaIsolatedPlanOptions.strictDataStatements,
    reorder: schemaIsolatedPlanOptions.reorder,
    connectionReuse: schemaIsolatedPlanOptions.connectionReuse,
    profile: legacyPgDeltaNextProfile(input.schema),
    ...(manifest !== undefined ? { manifest } : {}),
    ...(input.allowSameDatabaseIdentity === true
      ? { allowSameDatabaseIdentity: true }
      : { allowSameDatabaseIdentity: false }),
  };
}

function legacyMakePgDeltaNextAdapter<FactBase, PlanOptions extends object, Plan, Subject>(
  libraries: LegacyPgDeltaNextLibraries<FactBase, PlanOptions, Plan, Subject>,
): LegacyPgDeltaNextAdapterShape {
  return {
    diff: (input: LegacyPgDeltaNextDiffInput) =>
      legacyTryPgDeltaNext("diff", async () => {
        const format = legacyPgDeltaNextFormatOptions(input.formatOptions);
        const profile = await libraries.resolveProfile(
          input.sourcePool,
          { redactSecrets: true },
          input.schema,
        );
        const [source, desired] = await Promise.all([
          profile.extract(input.sourcePool, { redactSecrets: true }),
          profile.extract(input.desiredPool, { redactSecrets: true }),
        ]);
        const generatedPlan = libraries.plan(source.factBase, desired.factBase, {
          ...profile.planOptions,
          redactSecrets: true,
        });
        const rendered = libraries.renderPlanFiles(generatedPlan, {
          allowDrops: input.allowDrops,
        });
        const renderedFiles = legacyFormatPgDeltaNextRenderedFiles(rendered.files, format);
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
          sql: renderedFiles.map((file) => file.contents).join("\n\n"),
          files: legacyNormalizePgDeltaNextRenderedFiles(renderedFiles),
          diagnostics,
          hazards: libraries.summarizeHazards(generatedPlan, [
            ...source.diagnostics,
            ...desired.diagnostics,
          ]),
          ...(input.debug
            ? {
                debug: {
                  sourceSnapshot: libraries.serializeSnapshot(source.factBase, {
                    pgVersion: source.pgVersion,
                    redactSecrets: true,
                    profile: profile.id,
                  }),
                  desiredSnapshot: libraries.serializeSnapshot(desired.factBase, {
                    pgVersion: desired.pgVersion,
                    redactSecrets: true,
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
        const format = legacyPgDeltaNextFormatOptions(input.formatOptions);
        const result = await libraries.planSchemaFiles(
          input.targetPool,
          input.shadowPool,
          input.files,
          legacyPgDeltaNextPlanOptions(input),
        );
        const rendered = libraries.renderPlanFiles(result.plan, {
          allowDrops: input.allowDrops,
        });
        const renderedFiles = legacyFormatPgDeltaNextRenderedFiles(rendered.files, format);
        const libraryDiagnostics = [
          ...result.loadDiagnostics,
          ...result.targetDiagnostics,
          ...result.driftDiagnostics,
        ];
        return {
          changes: rendered.changes,
          sql: renderedFiles.map((file) => file.contents).join("\n\n"),
          files: legacyNormalizePgDeltaNextRenderedFiles(renderedFiles),
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
            ...legacyNormalizePgDeltaNextDiagnostics(
              result.driftDiagnostics,
              "declarativeDrift",
              libraries.encodeSubject,
            ),
            ...legacySkippedStatementDiagnostics(result.skipped),
          ],
          hazards: libraries.summarizeHazards(result.plan, libraryDiagnostics),
          skipped: result.skipped.map((skipped) => ({
            file: skipped.file,
            statement: skipped.stmt,
          })),
          removals: libraries.summarizeRemovals(result.plan),
          ...(input.debug ? { debug: { plan: libraries.serializePlan(result.plan) } } : {}),
        };
      }),
    captureSnapshot: (input: LegacyPgDeltaNextSnapshotCaptureInput) =>
      legacyTryPgDeltaNext("snapshotCapture", async () => {
        const profile = await libraries.resolveProfile(input.pool, {
          redactSecrets: true,
          skipBaseline: true,
        });
        const result = await profile.extract(input.pool, { redactSecrets: true });
        return {
          generation: "v2",
          snapshot: libraries.serializeSnapshot(result.factBase, {
            pgVersion: result.pgVersion,
            redactSecrets: true,
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
  resolveProfile: (
    pool: Pool,
    options: Parameters<typeof resolveProfile>[2],
    schema?: readonly string[],
  ) => resolveProfile(pool, legacyPgDeltaNextProfile(schema), options),
  plan,
  renderPlanFiles,
  buildSchemaExport,
  planSchemaFiles: (
    targetPool: Pool,
    shadowPool: Pool,
    files: readonly LegacyPgDeltaNextSqlFile[],
    input: LegacyPgDeltaNextLibraryPlanOptions,
  ) =>
    planSchemaFiles(
      targetPool,
      shadowPool,
      files.map((file) => ({ name: file.name, sql: file.sql })),
      input,
    ),
  serializeSnapshot,
  serializePlan,
  summarizeRemovals: legacySummarizePgDeltaNextRemovals,
  summarizeHazards: legacySummarizePgDeltaNextHazards,
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
