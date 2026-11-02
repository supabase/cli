import { Schema, SchemaTransformation } from "effect";

/** The security rules `[db.migrations.checks]` accepts, named as in the database linter. */
export const MIGRATION_CHECK_RULES = [
  "rls_disabled_in_public",
  "rls_enabled_no_policy",
  "policy_exists_rls_disabled",
  "security_definer_view",
  "rls_policy_always_true",
  "sensitive_columns_exposed",
  "auth_users_exposed",
  "function_search_path_mutable",
  "rls_references_user_metadata",
] as const;

export type MigrationCheckRule = (typeof MIGRATION_CHECK_RULES)[number];

const SEVERITIES = ["error", "warn", "off"] as const;

export type MigrationCheckSeverity = (typeof SEVERITIES)[number];

/** The severity used when a migration check rule is unset. */
export const DEFAULT_MIGRATION_CHECK_SEVERITY = "warn";
const SUGGESTION_MAX_DISTANCE = 3;
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

// Only the first dot separates schema from name; whitespace is allowed inside either, not at their edges.
const ObjectName = Schema.String.check(
  Schema.isPattern(/^(?!\s)[^.]*[^.\s]\.(?!\s)[\s\S]*\S(?![\s\S])/u),
);

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
    'Security checks run on each migration. Each rule takes "error", "warn" or "off"; a rule left unset uses "warn". When migrations run against --db-url, this section is read only from the local config.toml.',
  tags,
});

const editDistance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
};

const closestKey = (key: string, candidates: ReadonlyArray<string>): string | undefined => {
  let best: { readonly rule: string; readonly distance: number } | undefined;
  for (const rule of candidates) {
    const distance = editDistance(key, rule);
    if (distance <= SUGGESTION_MAX_DISTANCE && (best === undefined || distance < best.distance)) {
      best = { rule, distance };
    }
  }
  return best?.rule;
};

const unknownRuleMessage = (key: string, section: string): string => {
  const candidates =
    section === "[db.migrations.checks]"
      ? [...MIGRATION_CHECK_RULES, "exclude"]
      : MIGRATION_CHECK_RULES;
  const suggestion = closestKey(key, candidates);
  return suggestion === undefined
    ? `"${key}" is not a known rule in ${section}. Check the spelling, or upgrade the CLI if a teammate added it. Known rules: ${MIGRATION_CHECK_RULES.join(", ")}.`
    : `Unknown ${suggestion === "exclude" ? "key" : "rule"} "${key}" in ${section}. Did you mean "${suggestion}"?`;
};

const isRule = (key: string): key is MigrationCheckRule =>
  MIGRATION_CHECK_RULES.some((rule) => rule === key);

const isSeverity = (value: unknown): boolean => SEVERITIES.some((severity) => severity === value);

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isObjectName = Schema.is(ObjectName);

interface RawIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly issue: string;
}

const severityIssues = (section: Readonly<Record<string, unknown>>): Array<RawIssue> =>
  Object.entries(section).flatMap(([key, value]): Array<RawIssue> => {
    if (key === "exclude") return [];
    if (!isRule(key)) {
      return [{ path: [key], issue: unknownRuleMessage(key, "[db.migrations.checks]") }];
    }
    return isSeverity(value)
      ? []
      : [
          {
            path: [key],
            issue: `${key} must be "error", "warn" or "off" (got ${JSON.stringify(value)})`,
          },
        ];
  });

const exclusionIssues = (exclude: unknown): Array<RawIssue> => {
  if (exclude === undefined) return [];
  if (!isPlainObject(exclude)) {
    return [{ path: ["exclude"], issue: "[db.migrations.checks.exclude] must be a table" }];
  }
  return Object.entries(exclude).flatMap(([key, entries]): Array<RawIssue> => {
    const path = ["exclude", key];
    if (!isRule(key)) {
      return [{ path, issue: unknownRuleMessage(key, "[db.migrations.checks.exclude]") }];
    }
    if (!Array.isArray(entries)) {
      return [
        {
          path,
          issue:
            "values under [db.migrations.checks.exclude] must be lists; severities go above it",
        },
      ];
    }
    return entries.flatMap((entry, index) =>
      isObjectName(entry)
        ? []
        : [
            {
              path: [...path, index],
              issue: `exclude entries are "schema.name", for example "public.countries" (got ${JSON.stringify(entry)})`,
            },
          ],
    );
  });
};

const migrationChecksIssues = (
  section: Readonly<Record<string, unknown>>,
): ReadonlyArray<RawIssue> | undefined => {
  const issues = [...severityIssues(section), ...exclusionIssues(section["exclude"])];
  return issues.length === 0 ? undefined : issues;
};

// Decoding starts from an open record so the filter sees unknown keys, which the loader's
// excess-property mode would otherwise drop before validation.
const RawMigrationChecks = Schema.Record(Schema.String, Schema.Unknown).check(
  Schema.makeFilter(migrationChecksIssues, {
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
