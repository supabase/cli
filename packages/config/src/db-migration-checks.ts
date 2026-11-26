import { Schema, SchemaTransformation } from "effect";
import { tableRuleFilter } from "./lib/table-rule.ts";
import {
  cliConfigMigrationChecksIssues,
  isPlainObject,
  type MigrationCheckRule,
  OBJECT_NAME_PATTERN,
  SEVERITIES,
} from "./db-migration-checks-rules.ts";

export {
  cliConfigMigrationChecksIssues,
  MIGRATION_CHECK_RULES,
  type MigrationCheckRule,
} from "./db-migration-checks-rules.ts";

export type MigrationCheckSeverity = (typeof SEVERITIES)[number];

/** The severity used when a migration check rule is unset. */
export const DEFAULT_MIGRATION_CHECK_SEVERITY = "warn";
const tags = ["database"];

const linterDocs = (rule: MigrationCheckRule) => ({
  name: `Database linter: ${rule}`,
  link: `https://supabase.com/docs/guides/database/database-linter?lint=${rule}`,
});

/** Builds an object with one entry per migration check rule. */
export const mapMigrationCheckRules = <A>(
  make: (rule: MigrationCheckRule) => A,
): { readonly [R in MigrationCheckRule]: A } => ({
  rls_disabled_in_public: make("rls_disabled_in_public"),
  rls_enabled_no_policy: make("rls_enabled_no_policy"),
  policy_exists_rls_disabled: make("policy_exists_rls_disabled"),
  security_definer_view: make("security_definer_view"),
  rls_policy_always_true: make("rls_policy_always_true"),
  sensitive_columns_exposed: make("sensitive_columns_exposed"),
  auth_users_exposed: make("auth_users_exposed"),
  function_search_path_mutable: make("function_search_path_mutable"),
  rls_references_user_metadata: make("rls_references_user_metadata"),
});

const Severity = Schema.Literals(SEVERITIES);

const ObjectName = Schema.String.check(Schema.isPattern(OBJECT_NAME_PATTERN));

const TypedMigrationChecks = Schema.Struct({
  ...mapMigrationCheckRules((rule) =>
    Schema.optionalKey(
      Severity.annotate({
        default: DEFAULT_MIGRATION_CHECK_SEVERITY,
        description: `Severity for ${rule}: "error" will block the migration; until blocking ships it reports like "warn". "warn" reports it, "off" skips the rule.`,
        tags,
        links: [linterDocs(rule)],
      }),
    ),
  ),
  exclude: Schema.optionalKey(
    Schema.Struct(
      mapMigrationCheckRules((rule) =>
        Schema.optionalKey(
          Schema.Array(ObjectName).annotate({
            description: `Objects ${rule} skips, each written "schema.name", for example "public.countries". An entry like "public.set_updated_at" matches every overload of that function.`,
            tags,
            links: [linterDocs(rule)],
          }),
        ),
      ),
    ).annotate({
      description: "Objects each rule skips, keyed by rule.",
      tags,
    }),
  ),
}).annotate({
  description:
    'Security checks run on each migration. Each rule takes "error", "warn" or "off"; a rule left unset uses "warn". When migrations run against --db-url, this section is read only from the local config file.',
  tags,
});

// Decoding starts from an open record so the filter sees unknown keys, which the loader's
// excess-property mode would otherwise drop before validation.
const RawMigrationChecks = Schema.Record(Schema.String, Schema.Unknown).check(
  tableRuleFilter(cliConfigMigrationChecksIssues, {
    toJsonSchema: () =>
      Schema.toJsonSchemaDocument(TypedMigrationChecks, { onExcessProperty: "error" }).schema,
  }),
);

const dedupeExclusions = (
  section: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const exclude = section["exclude"];
  if (!isPlainObject(exclude)) return section;
  return {
    ...section,
    exclude: Object.fromEntries(
      Object.entries(exclude).map(([rule, entries]) => [
        rule,
        Array.isArray(entries) ? [...new Set(entries)] : entries,
      ]),
    ),
  };
};

/** `[db.migrations.checks]`: per-rule severities and per-rule exclusions for migration checks. */
export const MigrationChecks = RawMigrationChecks.pipe(
  Schema.decodeTo(
    TypedMigrationChecks,
    SchemaTransformation.transform({
      decode: dedupeExclusions,
      encode: (section) => section,
    }),
  ),
);

export type MigrationChecks = typeof MigrationChecks.Type;
