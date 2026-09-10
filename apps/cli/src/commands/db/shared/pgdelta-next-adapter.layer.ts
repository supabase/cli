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
import { formatSqlStatements, type SqlFormatOptions } from "@supabase/pg-delta/sql-format";

import {
  PgDeltaNextAdapter,
  PgDeltaNextError,
  type PgDeltaNextAdapterShape,
  type PgDeltaNextDeclarativeExportInput,
  type PgDeltaNextDeclarativePlanInput,
  type PgDeltaNextDiagnostic,
  type PgDeltaNextDiagnosticOrigin,
  type PgDeltaNextDiffInput,
  type PgDeltaNextExportManifest,
  type PgDeltaNextHazardReport,
  type PgDeltaNextRenderedFile,
  type PgDeltaNextSnapshotCaptureInput,
  type PgDeltaNextSqlFile,
  type PgDeltaNextOperation,
} from "./pgdelta-next-adapter.service.ts";
import type { PgDeltaErrorDiagnostic, PgDeltaRemovalSummary } from "./pgdelta-engine.service.ts";
import { PG_DELTA_NEXT_SKIPPED_STATEMENT_CODE } from "./pgdelta-next-diagnostics.ts";

interface PgDeltaNextLibraryDiagnostic<Subject> {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly subject?: Subject;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

interface PgDeltaNextLibraryExtractResult<FactBase, Subject> {
  readonly factBase: FactBase;
  readonly pgVersion: string;
  readonly diagnostics: readonly PgDeltaNextLibraryDiagnostic<Subject>[];
}

interface PgDeltaNextResolvedProfile<FactBase, PlanOptions extends object, Subject> {
  readonly id: string;
  readonly planOptions: PlanOptions;
  readonly extract: (
    pool: Pool,
    options?: { readonly redactSecrets?: boolean; readonly statementTimeoutMs?: number },
  ) => Promise<PgDeltaNextLibraryExtractResult<FactBase, Subject>>;
}

interface PgDeltaNextLibraryRenderedFile {
  readonly suffix: string | null;
  readonly contents: string;
  readonly transactional: boolean;
  readonly actionCount: number;
}

interface PgDeltaNextLibraryRenderedResult {
  readonly changes: boolean;
  readonly files: readonly PgDeltaNextLibraryRenderedFile[];
}

interface PgDeltaNextLibrarySchemaExport<Subject> {
  readonly files: readonly PgDeltaNextSqlFile[];
  readonly diagnostics: readonly PgDeltaNextLibraryDiagnostic<Subject>[];
  readonly manifest: PgDeltaNextExportManifest;
}

type PgDeltaNextLibraryExportOptions = ReturnType<typeof pgDeltaNextExportOptions>;
type PgDeltaNextLibraryPlanOptions = ReturnType<typeof pgDeltaNextPlanOptions>;

interface PgDeltaNextLibrarySchemaPlan<Plan, Subject> {
  readonly plan: Plan;
  readonly loadDiagnostics: readonly PgDeltaNextLibraryDiagnostic<Subject>[];
  readonly targetDiagnostics: readonly PgDeltaNextLibraryDiagnostic<Subject>[];
  readonly driftDiagnostics: readonly PgDeltaNextLibraryDiagnostic<Subject>[];
  readonly skipped: readonly { readonly file: string; readonly stmt: string }[];
}

export interface PgDeltaNextLibraries<FactBase, PlanOptions extends object, Plan, Subject> {
  readonly resolveProfile: (
    pool: Pool,
    options: {
      readonly restrictToApplier?: boolean;
      readonly redactSecrets?: boolean;
      readonly skipBaseline?: boolean;
    },
    schema?: readonly string[],
  ) => Promise<PgDeltaNextResolvedProfile<FactBase, PlanOptions, Subject>>;
  readonly plan: (
    source: FactBase,
    desired: FactBase,
    options: PlanOptions & { readonly redactSecrets: boolean },
  ) => Plan;
  readonly renderPlanFiles: (
    plan: Plan,
    options: { readonly allowDrops: boolean },
  ) => PgDeltaNextLibraryRenderedResult;
  readonly buildSchemaExport: (
    pool: Pool,
    input: PgDeltaNextLibraryExportOptions,
  ) => Promise<PgDeltaNextLibrarySchemaExport<Subject>>;
  readonly planSchemaFiles: (
    targetPool: Pool,
    shadowPool: Pool,
    files: readonly PgDeltaNextSqlFile[],
    input: PgDeltaNextLibraryPlanOptions,
  ) => Promise<PgDeltaNextLibrarySchemaPlan<Plan, Subject>>;
  readonly serializeSnapshot: (
    factBase: FactBase,
    metadata: {
      readonly pgVersion: string;
      readonly redactSecrets: boolean;
      readonly profile: string;
    },
  ) => string;
  readonly serializePlan: (plan: Plan) => string;
  readonly summarizeRemovals: (plan: Plan) => PgDeltaRemovalSummary;
  readonly summarizeHazards: (
    plan: Plan,
    diagnostics: readonly PgDeltaNextLibraryDiagnostic<Subject>[],
  ) => PgDeltaNextHazardReport;
  readonly encodeSubject: (subject: Subject) => string;
}

export function summarizePgDeltaNextRemovals(
  generatedPlan: Pick<PgDeltaPlan, "deltas">,
): PgDeltaRemovalSummary {
  const extensions = new Set<string>();
  const extensionIntents = new Map<string, PgDeltaRemovalSummary["extensionIntents"][number]>();
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

export function summarizePgDeltaNextHazards(
  generatedPlan: Pick<PgDeltaPlan, "actions">,
  diagnostics: readonly PgDeltaDiagnostic[],
): PgDeltaNextHazardReport {
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

function pgDeltaNextMessage(operation: PgDeltaNextOperation, cause: unknown): string {
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

function pgDeltaNextErrorDiagnostics(
  cause: unknown,
): readonly PgDeltaErrorDiagnostic[] | undefined {
  if (!(cause instanceof ShadowLoadError)) return undefined;
  return cause.details.map((diagnostic) => ({
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.context !== undefined ? { context: { ...diagnostic.context } } : {}),
  }));
}

function tryPgDeltaNext<Success>(operation: PgDeltaNextOperation, run: () => Promise<Success>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => {
      const diagnostics = pgDeltaNextErrorDiagnostics(cause);
      return new PgDeltaNextError({
        operation,
        message: pgDeltaNextMessage(operation, cause),
        cause,
        ...(diagnostics !== undefined ? { diagnostics } : {}),
      });
    },
  });
}

function isLibraryDiagnostic<Subject>(
  value: unknown,
): value is PgDeltaNextLibraryDiagnostic<Subject> {
  if (typeof value !== "object" || value === null) return false;
  const severity = Reflect.get(value, "severity");
  return (
    typeof Reflect.get(value, "code") === "string" &&
    typeof Reflect.get(value, "message") === "string" &&
    (severity === "error" || severity === "warning" || severity === "info")
  );
}

function readPlanDiagnostics<Subject>(
  plan: unknown,
): readonly PgDeltaNextLibraryDiagnostic<Subject>[] {
  if (typeof plan !== "object" || plan === null) return [];
  const diagnostics = Reflect.get(plan, "diagnostics");
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.filter((diagnostic) => isLibraryDiagnostic<Subject>(diagnostic));
}

function normalizePgDeltaNextDiagnostics<Subject>(
  diagnostics: readonly PgDeltaNextLibraryDiagnostic<Subject>[],
  origin: PgDeltaNextDiagnosticOrigin,
  encodeSubject: (subject: Subject) => string,
): PgDeltaNextDiagnostic[] {
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
 * Routes `planSchemaFiles`' skipped statements through the shared diagnostic-report path,
 * warned by default and blocking under `--strict-coverage`, instead of an unread `skipped`
 * field; the raw statement is kept verbatim since it's already the user's own file content.
 */
function skippedStatementDiagnostics(
  skipped: readonly { readonly file: string; readonly stmt: string }[],
): PgDeltaNextDiagnostic[] {
  return skipped.map((entry) => ({
    origin: "declarativeLoad",
    code: PG_DELTA_NEXT_SKIPPED_STATEMENT_CODE,
    severity: "warning",
    subject: entry.file,
    message: `pg-delta could not load a declarative schema statement from ${entry.file}: ${entry.stmt}`,
    context: { file: entry.file, statement: entry.stmt },
  }));
}

function normalizePgDeltaNextRenderedFiles(
  files: readonly PgDeltaNextLibraryRenderedFile[],
): PgDeltaNextRenderedFile[] {
  return files.map((file, index) => ({
    sequence: index + 1,
    suffix: file.suffix,
    sql: file.contents,
    transactionMode: file.transactional ? "transactional" : "none",
    actionCount: file.actionCount,
  }));
}

export function pgDeltaNextProfile(schema: readonly string[] | undefined): IntegrationProfile {
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

/** Human-readable SQL when `[experimental.pgdelta] format_options` is omitted. */
export const pgDeltaNextDefaultFormatOptions = {
  keywordCase: "upper",
  indent: 2,
  maxWidth: 180,
  commaStyle: "trailing",
  alignColumns: true,
  alignKeyValues: true,
} satisfies SqlFormatOptions;

function pgDeltaNextFormatOptions(raw: string | undefined): SqlFormatOptions | undefined {
  if (raw === undefined || raw.trim().length === 0) return pgDeltaNextDefaultFormatOptions;
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null) return undefined;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return pgDeltaNextDefaultFormatOptions;
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
    ...pgDeltaNextDefaultFormatOptions,
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

function terminatePgDeltaNextStatement(sql: string): string {
  const trimmed = sql.trimEnd();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

export function formatPgDeltaNextSql(sql: string, format: SqlFormatOptions | undefined): string {
  if (format === undefined) return sql;
  return `${formatSqlStatements([sql], format).map(terminatePgDeltaNextStatement).join("\n\n")}\n`;
}

function formatPgDeltaNextRenderedFiles(
  files: readonly PgDeltaNextLibraryRenderedFile[],
  format: SqlFormatOptions | undefined,
): readonly PgDeltaNextLibraryRenderedFile[] {
  if (format === undefined) return files;
  return files.map((file) => ({
    ...file,
    contents: formatPgDeltaNextSql(file.contents, format),
  }));
}

function pgDeltaNextExportOptions(input: PgDeltaNextDeclarativeExportInput) {
  const format = pgDeltaNextFormatOptions(input.formatOptions);
  return {
    profile: pgDeltaNextProfile(input.schema),
    layout: "grouped" as const,
    ...(format !== undefined ? { format } : {}),
  };
}

function pgDeltaNextPlanOptions(input: PgDeltaNextDeclarativePlanInput) {
  let manifest;
  if (input.manifest !== undefined) {
    const { files, loadOrder, ...metadata } = input.manifest;
    manifest = {
      ...metadata,
      ...(files !== undefined ? { files: [...files] } : {}),
      ...(loadOrder !== undefined ? { loadOrder: [...loadOrder] } : {}),
    };
  }
  // Isolated load only. pg-delta's preflight derives scope/redactSecrets from
  // the manifest and files — do not pin those here.
  return {
    profile: pgDeltaNextProfile(input.schema),
    ...(manifest !== undefined ? { manifest } : {}),
    isolatedShadow: true,
    ...(input.allowSameDatabaseIdentity === true ? { allowSameDatabaseIdentity: true } : {}),
    seedAssumedSchemas: false,
    strictDataStatements: true,
    reorder: true,
    connectionReuse: "reconnect-on-stuck" as const,
  };
}

function makePgDeltaNextAdapter<FactBase, PlanOptions extends object, Plan, Subject>(
  libraries: PgDeltaNextLibraries<FactBase, PlanOptions, Plan, Subject>,
): PgDeltaNextAdapterShape {
  return {
    diff: (input: PgDeltaNextDiffInput) =>
      tryPgDeltaNext("diff", async () => {
        const format = pgDeltaNextFormatOptions(input.formatOptions);
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
        const renderedFiles = formatPgDeltaNextRenderedFiles(rendered.files, format);
        const planDiagnostics = readPlanDiagnostics<Subject>(generatedPlan);
        const diagnostics = [
          ...normalizePgDeltaNextDiagnostics(source.diagnostics, "source", libraries.encodeSubject),
          ...normalizePgDeltaNextDiagnostics(
            desired.diagnostics,
            "desired",
            libraries.encodeSubject,
          ),
          ...normalizePgDeltaNextDiagnostics(planDiagnostics, "plan", libraries.encodeSubject),
        ];
        return {
          changes: rendered.changes,
          sql: renderedFiles.map((file) => file.contents).join("\n\n"),
          files: normalizePgDeltaNextRenderedFiles(renderedFiles),
          diagnostics,
          hazards: libraries.summarizeHazards(generatedPlan, [
            ...source.diagnostics,
            ...desired.diagnostics,
            ...planDiagnostics,
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
    exportDeclarativeSchema: (input: PgDeltaNextDeclarativeExportInput) =>
      tryPgDeltaNext("declarativeExport", async () => {
        const result = await libraries.buildSchemaExport(
          input.pool,
          pgDeltaNextExportOptions(input),
        );
        return {
          files: result.files.map((file) => ({ name: file.name, sql: file.sql })),
          manifest: {
            ...result.manifest,
            files: result.files.map((file) => file.name).sort(),
          },
          diagnostics: normalizePgDeltaNextDiagnostics(
            result.diagnostics,
            "export",
            libraries.encodeSubject,
          ),
        };
      }),
    planDeclarativeSchema: (input: PgDeltaNextDeclarativePlanInput) =>
      tryPgDeltaNext("declarativePlan", async () => {
        const format = pgDeltaNextFormatOptions(input.formatOptions);
        const result = await libraries.planSchemaFiles(
          input.targetPool,
          input.shadowPool,
          input.files,
          pgDeltaNextPlanOptions(input),
        );
        const rendered = libraries.renderPlanFiles(result.plan, {
          allowDrops: input.allowDrops,
        });
        const renderedFiles = formatPgDeltaNextRenderedFiles(rendered.files, format);
        const planDiagnostics = readPlanDiagnostics<Subject>(result.plan);
        const libraryDiagnostics = [
          ...result.loadDiagnostics,
          ...result.targetDiagnostics,
          ...result.driftDiagnostics,
          ...planDiagnostics,
        ];
        return {
          changes: rendered.changes,
          sql: renderedFiles.map((file) => file.contents).join("\n\n"),
          files: normalizePgDeltaNextRenderedFiles(renderedFiles),
          diagnostics: [
            ...normalizePgDeltaNextDiagnostics(
              result.loadDiagnostics,
              "declarativeLoad",
              libraries.encodeSubject,
            ),
            ...normalizePgDeltaNextDiagnostics(
              result.targetDiagnostics,
              "declarativeTarget",
              libraries.encodeSubject,
            ),
            ...normalizePgDeltaNextDiagnostics(
              result.driftDiagnostics,
              "declarativeDrift",
              libraries.encodeSubject,
            ),
            ...normalizePgDeltaNextDiagnostics(planDiagnostics, "plan", libraries.encodeSubject),
            ...skippedStatementDiagnostics(result.skipped),
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
    captureSnapshot: (input: PgDeltaNextSnapshotCaptureInput) =>
      tryPgDeltaNext("snapshotCapture", async () => {
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
          diagnostics: normalizePgDeltaNextDiagnostics(
            result.diagnostics,
            "snapshot",
            libraries.encodeSubject,
          ),
        };
      }),
  };
}

const pgDeltaNextRealLibraries = {
  resolveProfile: (
    pool: Pool,
    options: Parameters<typeof resolveProfile>[2],
    schema?: readonly string[],
  ) => resolveProfile(pool, pgDeltaNextProfile(schema), options),
  plan,
  renderPlanFiles,
  buildSchemaExport,
  planSchemaFiles: (
    targetPool: Pool,
    shadowPool: Pool,
    files: readonly PgDeltaNextSqlFile[],
    input: PgDeltaNextLibraryPlanOptions,
  ) =>
    planSchemaFiles(
      targetPool,
      shadowPool,
      files.map((file) => ({ name: file.name, sql: file.sql })),
      input,
    ),
  serializeSnapshot,
  serializePlan,
  summarizeRemovals: summarizePgDeltaNextRemovals,
  summarizeHazards: summarizePgDeltaNextHazards,
  encodeSubject: encodeId,
};

export function pgDeltaNextAdapterLayerFromLibraries<
  FactBase,
  PlanOptions extends object,
  Plan,
  Subject,
>(libraries: PgDeltaNextLibraries<FactBase, PlanOptions, Plan, Subject>) {
  return Layer.succeed(
    PgDeltaNextAdapter,
    PgDeltaNextAdapter.of(makePgDeltaNextAdapter(libraries)),
  );
}

export const pgDeltaNextAdapterLayer =
  pgDeltaNextAdapterLayerFromLibraries(pgDeltaNextRealLibraries);
