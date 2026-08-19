import type { SqlFileClassification } from "@supabase/pg-delta/frontends";
import type { HazardReport } from "@supabase/pg-delta/plan";
import type { Plan } from "@supabase/pg-delta/plan";
import type { ApplyReport } from "@supabase/pg-delta/apply";

type SchemaCommandStatus =
  | "clean"
  | "draft"
  | "needs_approval"
  | "generated"
  | "drift"
  | "conflict"
  | "partial"
  | "failed";

export type SchemaSqlFile = {
  readonly name: string;
  readonly sql: string;
};

export type SchemaHazardSummary = {
  readonly kinds: ReadonlyArray<string>;
  readonly destructive: number;
  readonly rewrite: number;
  readonly coverageGaps: number;
  readonly report: HazardReport;
};

export type SchemaRenderedFile = {
  readonly sequence: number;
  readonly suffix: string | null;
  readonly sql: string;
  readonly transactional: boolean;
  readonly actionCount: number;
};

export type SchemaPlanView = {
  readonly planId: string;
  readonly sourceFingerprint: string;
  readonly desiredFingerprint: string;
  readonly engineVersion: string;
  readonly profile: string;
  readonly changes: boolean;
  readonly files: ReadonlyArray<SchemaRenderedFile>;
  readonly hazards: SchemaHazardSummary;
  readonly destructive: boolean;
  readonly renameCandidates: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly acceptedRenames: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly coverageBlocked: boolean;
  readonly renameBlocked: boolean;
  readonly plan: Plan;
};

export type SchemaApplyOutcome = {
  readonly report: ApplyReport;
  readonly partial: boolean;
};

export type SchemaFileSummary = Pick<
  SqlFileClassification,
  "created" | "updated" | "unchanged" | "removed" | "unmanaged"
>;

export type SchemaCheckpoint = {
  readonly version: 1;
  readonly declarativeDigest: string;
  readonly migrationHeadDigest: string;
  readonly sourceFingerprint?: string;
  readonly desiredFingerprint?: string;
  readonly profile: string;
  readonly scope: "database";
  readonly engineVersion: string;
  readonly artifactFormatVersion: number;
  readonly acceptedRenames: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly exportManifestIdentity?: string;
  readonly catalogSnapshot?: string;
  readonly lastGenerateName?: string;
  readonly lastGenerateHazards?: Pick<
    SchemaHazardSummary,
    "kinds" | "destructive" | "rewrite" | "coverageGaps"
  >;
  readonly generatedMigrationVersions?: ReadonlyArray<string>;
  readonly destructiveMigrationVersions?: ReadonlyArray<string>;
};

type SchemaJournaledPlan = {
  readonly planId: string;
  readonly targetFingerprint: string;
  readonly acceptedRenames: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly segmentDigests: ReadonlyArray<string>;
  readonly hazards: Pick<SchemaHazardSummary, "kinds" | "destructive" | "rewrite" | "coverageGaps">;
  readonly actionStatuses: ReadonlyArray<"applied" | "unapplied" | "inDoubt">;
  readonly outcome: "applied" | "failed" | "partial";
};

export type SchemaDraftJournal = {
  readonly version: 1;
  readonly draftId: string;
  readonly targetIdentity: string;
  readonly startingMigrationHeadDigest: string;
  readonly sourceFingerprint: string;
  readonly plans: ReadonlyArray<SchemaJournaledPlan>;
  readonly engineVersion: string;
  readonly declarativelyAhead: boolean;
  readonly generated?: boolean;
  readonly invalidationReason?: string;
};

export type SchemaCommandResult = {
  readonly status: SchemaCommandStatus;
  readonly message: string;
  readonly data: Record<string, unknown>;
  readonly nextActions: ReadonlyArray<string>;
  readonly mutatedDatabase: boolean;
  readonly mutatedFiles: boolean;
};
