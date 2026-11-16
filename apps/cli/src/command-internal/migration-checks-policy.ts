import type { CliConfig } from "@supabase/config";
import {
  DEFAULT_MIGRATION_CHECK_SEVERITY,
  MIGRATION_CHECK_RULES,
  mapMigrationCheckRules,
  type MigrationCheckRule,
  type MigrationCheckSeverity,
} from "@supabase/config/internal";

type MigrationChecksConfig = CliConfig["db"]["migrations"]["checks"];

/** One object a rule skips, written "schema.name". */
interface MigrationCheckExclusion {
  readonly rule: MigrationCheckRule;
  readonly object: string;
}

/** The migration check policy in the shape `@supabase/pg-checks` takes. */
export interface MigrationChecksPolicy {
  readonly severities: { readonly [R in MigrationCheckRule]: MigrationCheckSeverity };
  readonly exclude: ReadonlyArray<MigrationCheckExclusion>;
}

/** Resolves `[db.migrations.checks]`: an unset rule is "warn", exclusions become rule/object pairs. */
export const resolveMigrationChecksPolicy = (
  checks: MigrationChecksConfig,
): MigrationChecksPolicy => ({
  severities: mapMigrationCheckRules((rule) => checks?.[rule] ?? DEFAULT_MIGRATION_CHECK_SEVERITY),
  exclude: MIGRATION_CHECK_RULES.flatMap((rule) =>
    (checks?.exclude?.[rule] ?? []).map((object) => ({ rule, object })),
  ),
});
