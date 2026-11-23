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
