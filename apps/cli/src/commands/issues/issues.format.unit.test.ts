import { describe, expect, it } from "vitest";
import { scanAdvisorLintRow } from "../../command-internal/advisors/advisors.format.ts";
import { Effect, Schema } from "effect";
import { Issue, groupIssues as group } from "./issues.format.ts";

const groupIssues = (...args: Parameters<typeof group>) => Effect.runSync(group(...args));
const lint = (values: Readonly<Record<string, unknown>> = {}) =>
  scanAdvisorLintRow({
    name: "check",
    title: "Check",
    description: "Check \\`resources\\`",
    detail: "Affected \\`resource\\`",
    categories: ["SECURITY"],
    level: "WARN",
    remediation: "https://example.com/check",
    cache_key: "one",
    ...values,
  });
describe("issue grouping", () => {
  it("filters on maximum group severity while retaining lower severity evidence and individual documentation", () => {
    const issues = groupIssues(
      [
        lint({ level: "INFO" }),
        lint({ level: "ERROR", cache_key: "two", remediation: "https://example.com/other" }),
      ],
      "critical",
    );
    expect(issues).toEqual([
      {
        id: "check",
        title: "Check",
        description: "Check `resources`",
        severity: "critical",
        category: "security",
        source: "lint",
        docs_url: "https://example.com/check",
        affected: [
          {
            id: "one",
            resource: { type: "project", name: "Project", schema: null },
            detail: "Affected `resource`",
            severity: "info",
            docs_url: "https://example.com/check",
            remediation: "https://example.com/check",
          },
          {
            id: "two",
            resource: { type: "project", name: "Project", schema: null },
            detail: "Affected `resource`",
            severity: "critical",
            docs_url: "https://example.com/other",
            remediation: "https://example.com/other",
          },
        ],
      },
    ]);
  });
  it.each([
    [
      { name: "calculate", arguments: "" },
      { type: "function", name: "calculate()", schema: null },
    ],
    [
      { name: "calculate", arguments: "text, integer", type: "function", schema: "api" },
      { type: "function", name: "calculate(text, integer)", schema: "api" },
    ],
    [
      { entity: "auth.users", type: "table", schema: "ignored" },
      { type: "table", name: "auth.users", schema: null },
    ],
    [
      { name: "settings", type: "compliance" },
      { type: "project", name: "settings", schema: null },
    ],
    [
      { name: "x", type: "future" },
      { type: "project", name: "x", schema: null },
    ],
    [
      { name: "reports", type: "materialized view", schema: "public" },
      { type: "materialized_view", name: "reports", schema: "public" },
    ],
  ])("preserves resource identities from metadata %j", (metadata, resource) => {
    expect(groupIssues([lint({ metadata })], "info")[0]?.affected[0]?.resource).toEqual(resource);
  });
  it("identifies outdated extensions by their SQL metadata", () => {
    const result = groupIssues(
      [
        lint({
          name: "extension_versions_outdated",
          cache_key: "extension_versions_outdated_pg_stat_statements_1.10",
          metadata: {
            extension_name: "pg_stat_statements",
            installed_version: "1.10",
            default_version: "1.11",
          },
        }),
        lint({
          name: "extension_versions_outdated",
          cache_key: "extension_versions_outdated_pg_graphql_1.5.11",
          metadata: {
            extension_name: "pg_graphql",
            installed_version: "1.5.11",
            default_version: "1.5.12",
          },
        }),
      ],
      "info",
    );
    expect(result[0]?.affected.map(({ resource }) => resource)).toEqual([
      { type: "extension", name: "pg_stat_statements", schema: null },
      { type: "extension", name: "pg_graphql", schema: null },
    ]);
  });
  it("identifies tables from foreign-key lints that omit the resource type", () => {
    const result = groupIssues(
      [
        lint({
          name: "fkey_to_auth_unique",
          cache_key: "fkey_to_auth_unique_public_profiles_profiles_email_fkey",
          metadata: { schema: "public", name: "profiles", foreign_key: "profiles_email_fkey" },
        }),
      ],
      "info",
    );
    expect(result[0]?.affected[0]?.resource).toEqual({
      type: "table",
      name: "profiles",
      schema: "public",
    });
    expect(result[0]?.affected[0]?.metadata).toEqual({
      schema: "public",
      name: "profiles",
      foreign_key: "profiles_email_fkey",
    });
  });
  it("uses source cache keys to distinguish functions when signatures are absent", () => {
    const metadata = { schema: "public", name: "lookup", type: "function" };
    const firstKey = "function_search_path_mutable_public_lookup_1b1aee4c303cb30f3b1b99f399a942bf";
    const secondKey = "function_search_path_mutable_public_lookup_d9fba05c5f1f705d8d5d18da0c7b7acd";
    const result = groupIssues(
      [
        lint({ name: "function_search_path_mutable", cache_key: firstKey, metadata }),
        lint({ name: "function_search_path_mutable", cache_key: secondKey, metadata }),
        lint({ name: "function_search_path_mutable", cache_key: firstKey, metadata }),
      ],
      "info",
    );
    expect(result[0]?.affected.map(({ resource }) => resource)).toEqual([
      { type: "function", name: "lookup", schema: "public", id: firstKey },
      { type: "function", name: "lookup", schema: "public", id: secondKey },
      { type: "function", name: "lookup", schema: "public", id: firstKey },
    ]);
  });
  it("uses supplied function signatures ahead of lint cache keys", () => {
    const result = groupIssues(
      [
        lint({
          name: "function_search_path_mutable",
          metadata: { schema: "public", name: "lookup", type: "function", arguments: "integer" },
        }),
      ],
      "info",
    );
    expect(result[0]?.affected[0]?.resource).toEqual({
      type: "function",
      name: "lookup(integer)",
      schema: "public",
    });
  });
  it("retains structured evidence through schema encoding", () => {
    const metadata = {
      name: "orders",
      type: "table",
      schema: "public",
      fkey_columns: [1, 2],
      fkey_name: "orders_customer_fkey",
      nested: { evidence: ["customer_id"] },
    };
    const issues = groupIssues([lint({ metadata })], "info");
    expect(Schema.encodeSync(Schema.Array(Issue))(issues)[0]?.affected[0]?.metadata).toEqual(
      metadata,
    );
  });
  it.each(["Enable RLS on the table", "", "javascript:alert(1)", "https://", "file:///tmp/docs"])(
    "preserves remediation %j and supplies an HTTP documentation link",
    (remediation) => {
      const result = groupIssues([lint({ remediation })], "info")[0];
      expect(result?.docs_url).toBe("https://supabase.com/docs/guides/database/database-linter");
      expect(result?.affected[0]).toMatchObject({
        remediation,
        docs_url: "https://supabase.com/docs/guides/database/database-linter",
      });
    },
  );
  it("sorts by severity then stable check id and excludes coverage diagnostics", () => {
    expect(
      groupIssues(
        [
          lint({ name: "z", level: "WARN" }),
          lint({ name: "b", level: "ERROR" }),
          lint({ name: "a", level: "ERROR" }),
          lint({ name: "advisor_check_unavailable" }),
        ],
        "info",
      ).map((issue) => issue.id),
    ).toEqual(["a", "b", "z"]);
  });
});
