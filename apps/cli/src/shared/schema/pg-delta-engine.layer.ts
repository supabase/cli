import { Effect, Layer } from "effect";
import type { Pool } from "pg";
import { apply } from "@supabase/pg-delta/apply";
import { encodeId, serializeSnapshot, type Diagnostic } from "@supabase/pg-delta/core";
import {
  buildSchemaExport,
  dataLossActions,
  hasBlockingDiagnostics,
  planSchemaFiles,
  renderPlanFiles,
  ShadowLoadError,
} from "@supabase/pg-delta/frontends";
import { resolveProfile, supabaseProfile } from "@supabase/pg-delta/integrations";
import {
  classifyPlanHazards,
  ENGINE_VERSION,
  plan as planCatalogs,
  type Plan,
} from "@supabase/pg-delta/plan";
import { IsolatedShadowProvisioner } from "./isolated-shadow.service.ts";
import { SchemaEngineError } from "./schema-errors.ts";
import {
  PgDeltaSchemaEngine,
  type SchemaDiffPoolsInput,
  type SchemaExportResult,
  type SchemaPlanFilesInput,
} from "./pg-delta-engine.service.ts";
import { prepareDeclarativeShadow } from "./prepare-declarative-shadow.ts";
import { schemaIsolatedPlanOptions } from "./schema-plan-options.ts";
import { formatSchemaSql, SCHEMA_SQL_FORMAT_DEFAULTS } from "./sql-format-defaults.ts";
import type { SchemaHazardSummary, SchemaPlanView, SchemaRenderedFile } from "./schema-types.ts";

const engineError = (detail: string, suggestion = "Inspect diagnostics and retry.") =>
  new SchemaEngineError({ detail, suggestion });

const engineCause = (cause: unknown, suggestion: string) => {
  if (cause instanceof ShadowLoadError) {
    const details = cause.details.map((diagnostic) => `  - ${diagnostic.message}`).join("\n");
    return engineError(
      details.length > 0 ? `${cause.message}\n${details}` : cause.message,
      suggestion,
    );
  }
  return engineError(cause instanceof Error ? cause.message : String(cause), suggestion);
};

function toPlanView(
  thePlan: Plan,
  allowDrops: boolean,
  diagnostics: ReadonlyArray<Diagnostic>,
): SchemaPlanView {
  const rendered = renderPlanFiles(thePlan, { allowDrops });
  const files: Array<SchemaRenderedFile> = rendered.files.map((file, index) => ({
    sequence: index + 1,
    suffix: file.suffix,
    sql: formatSchemaSql(file.contents, SCHEMA_SQL_FORMAT_DEFAULTS),
    transactional: file.transactional,
    actionCount: file.actionCount,
  }));
  const hazards = classifyPlanHazards(thePlan, diagnostics);
  const destructive = dataLossActions(thePlan.actions).length;
  const summary: SchemaHazardSummary = {
    kinds: [...hazards.kinds],
    destructive,
    rewrite: hazards.kinds.includes("rewrite_risk") ? 1 : 0,
    coverageGaps: hazards.coverage.length,
    report: hazards,
  };
  const renameBlocked = thePlan.renameCandidates.some(
    (candidate) => candidate.status === "ambiguous",
  );
  return {
    planId: thePlan.planId,
    sourceFingerprint: thePlan.source.fingerprint,
    desiredFingerprint: thePlan.target.fingerprint,
    engineVersion: thePlan.engineVersion,
    profile: thePlan.profile?.id ?? "supabase",
    changes: rendered.changes,
    files,
    hazards: summary,
    destructive: destructive > 0,
    renameCandidates: thePlan.renameCandidates.map((candidate) => ({
      from: encodeId(candidate.from),
      to: encodeId(candidate.to),
    })),
    acceptedRenames: (thePlan.acceptedRenames ?? []).map((rename) => ({
      from: encodeId(rename.from),
      to: encodeId(rename.to),
    })),
    coverageBlocked:
      hasBlockingDiagnostics(diagnostics, { strictCoverage: true }) || hazards.coverage.length > 0,
    renameBlocked,
    diagnostics,
    plan: thePlan,
  };
}

export const pgDeltaSchemaEngineLayer = Layer.effect(
  PgDeltaSchemaEngine,
  Effect.gen(function* () {
    const shadows = yield* IsolatedShadowProvisioner;
    return PgDeltaSchemaEngine.of({
      exportSchema: (pool: Pool) =>
        Effect.tryPromise({
          try: async (): Promise<SchemaExportResult> => {
            const exported = await buildSchemaExport(pool, {
              profile: supabaseProfile,
              scope: "database",
              redactSecrets: true,
              format: SCHEMA_SQL_FORMAT_DEFAULTS,
            });
            const ctx = await resolveProfile(pool, supabaseProfile, { redactSecrets: true });
            const extracted = await ctx.extract(pool, { redactSecrets: true });
            return {
              files: exported.files.map((file) => ({ name: file.name, sql: file.sql })),
              manifest: {
                ...exported.manifest,
                files: exported.files.map((file) => file.name).sort(),
              },
              snapshot: serializeSnapshot(extracted.factBase, {
                pgVersion: extracted.pgVersion,
                redactSecrets: true,
                profile: ctx.id,
              }),
              engineVersion: ENGINE_VERSION,
            };
          },
          catch: (cause) =>
            engineCause(cause, "Confirm the database is reachable and retry schema pull."),
        }),
      planFiles: (input: SchemaPlanFilesInput) =>
        Effect.gen(function* () {
          yield* prepareDeclarativeShadow(input.shadowPool);
          return yield* Effect.tryPromise({
            try: async () => {
              const result = await planSchemaFiles(
                input.targetPool,
                input.shadowPool,
                [...input.files],
                {
                  ...schemaIsolatedPlanOptions,
                  ...(input.manifest !== undefined ? { manifest: input.manifest } : {}),
                },
              );
              return toPlanView(result.plan, input.allowDrops ?? true, [
                ...result.loadDiagnostics,
                ...result.targetDiagnostics,
                ...result.driftDiagnostics,
              ]);
            },
            catch: (cause) => engineCause(cause, "Fix declaration or coverage issues, then retry."),
          });
        }),
      diffPools: (input: SchemaDiffPoolsInput) =>
        Effect.tryPromise({
          try: async () => {
            const profile = await resolveProfile(input.sourcePool, supabaseProfile, {
              redactSecrets: true,
            });
            const source = await profile.extract(input.sourcePool, { redactSecrets: true });
            const desired = await profile.extract(input.desiredPool, { redactSecrets: true });
            const generated = planCatalogs(source.factBase, desired.factBase, {
              ...profile.planOptions,
              redactSecrets: true,
            });
            return toPlanView(generated, input.allowDrops ?? true, [
              ...source.diagnostics,
              ...desired.diagnostics,
            ]);
          },
          catch: (cause) => engineCause(cause, "Confirm both databases are reachable and retry."),
        }),
      applyPlan: (input) =>
        Effect.tryPromise({
          try: async () => {
            const report = await apply(input.plan.plan, input.pool, {
              fingerprintGate: true,
              ...input.applyOptions,
            });
            return {
              report,
              partial:
                report.status === "failed" ||
                report.actionStatuses.some(
                  (status) => status === "inDoubt" || status === "unapplied",
                ),
            };
          },
          catch: (cause) =>
            engineCause(
              cause,
              "The draft journal recorded the failure. Reset or repair; do not retry blindly.",
            ),
        }),
      provisionShadow: shadows.provision,
      provisionPlatform: shadows.provisionPlatform,
      provisionMigrations: shadows.provisionMigrations,
    });
  }),
);
