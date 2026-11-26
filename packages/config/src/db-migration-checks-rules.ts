import type { CliConfigTableRuleIssue } from "./lib/table-rule-issue.ts";

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

export const SEVERITIES = ["error", "warn", "off"] as const;

const SUGGESTION_MAX_DISTANCE = 3;

// Only the first dot separates schema from name; whitespace is allowed inside either, not at their edges.
export const OBJECT_NAME_PATTERN = /^(?!\s)[^.]*[^.\s]\.(?!\s)[\s\S]*\S(?![\s\S])/u;

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

export const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isObjectName = (value: unknown): boolean =>
  typeof value === "string" && OBJECT_NAME_PATTERN.test(value);

interface RawIssue {
  readonly path: ReadonlyArray<string | number>;
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

/** Rule-name, severity and exclusion issues of the raw `[db.migrations.checks]` table, before decoding drops unknown keys. */
export const cliConfigMigrationChecksIssues = (
  section: Readonly<Record<string, unknown>>,
): ReadonlyArray<CliConfigTableRuleIssue> =>
  [...severityIssues(section), ...exclusionIssues(section["exclude"])].map(({ path, issue }) => ({
    path,
    message: issue,
  }));
