import { describe, expect, it } from "vitest";
import { stringWidth } from "../../command-internal/string-width.ts";
import type { Issue } from "./issues.format.ts";
import { Effect } from "effect";
import { scanAdvisorLintRow } from "../../command-internal/advisors/advisors.format.ts";
import { groupIssues } from "./issues.format.ts";
import { renderIssuesText } from "./issues.text.ts";

const title = "Long table check 界🙂e\u0301 ".repeat(12) + "\u001b[31m\nInjected line";
const issue: Issue = {
  id: "long_check",
  title,
  description: "",
  severity: "warning",
  category: "performance",
  source: "lint",
  docs_url: "https://example.com/check",
  affected: [
    {
      id: "one",
      resource: { type: "project", name: "Project", schema: null },
      detail: "",
      severity: "warning",
      docs_url: "https://example.com/check",
      remediation: "https://example.com/check",
    },
  ],
};

describe("readable issue tables", () => {
  it.each([20, 120])(
    "counts observed function rows when upstream cache identities collide at %s columns",
    (width) => {
      const rows = [
        "function_search_path_mutable_public_lookup_1b1aee4c303cb30f3b1b99f399a942bf",
        "function_search_path_mutable_public_lookup_d9fba05c5f1f705d8d5d18da0c7b7acd",
        "function_search_path_mutable_public_lookup_1b1aee4c303cb30f3b1b99f399a942bf",
      ].map((cache_key) =>
        scanAdvisorLintRow({
          name: "function_search_path_mutable",
          title: "Check",
          level: "WARN",
          categories: ["SECURITY"],
          metadata: { type: "function", schema: "public", name: "lookup" },
          cache_key,
        }),
      );
      const issues = Effect.runSync(groupIssues(rows, "info"));
      expect(issues[0]?.affected).toHaveLength(3);
      const output = renderIssuesText(issues, [], "info", width);
      expect(
        width === 20 ? output : output.split("\n").find((line) => line.includes("Check")),
      ).toMatch(width === 20 ? /Affected:\n  3/ : /│\s*3\s*│/);
    },
  );
  it.each([20, 120])(
    "counts distinct resources without counting duplicate findings at %s columns",
    (width) => {
      const affected = (id: string, type: string, schema: string, name: string) => ({
        id,
        resource: { type, schema, name },
        detail: id,
        severity: "warning" as const,
        docs_url: "https://example.com/check",
        remediation: "https://example.com/check",
      });
      const findings = [
        affected("one", "table", "public", "orders"),
        affected("two", "table", "public", "orders"),
        affected("three", "view", "public", "orders"),
        affected("four", "table", "private", "orders"),
        affected("five", "table", "public", "customers"),
      ];
      const output = renderIssuesText(
        [{ ...issue, title: "Check", affected: findings }],
        [],
        "info",
        width,
      );
      expect(
        width === 20 ? output : output.split("\n").find((line) => line.includes("Check")),
      ).toMatch(width === 20 ? /Affected:\n  4/ : /│\s*4\s*│/);
    },
  );
  it.each([20, 40, 45, 49, 80, 120])(
    "preserves long Unicode titles and unavailable reasons within %s columns",
    (width) => {
      const reason = "Backend check unavailable 界🙂 ".repeat(12) + "\u001b[2J";
      const output = renderIssuesText(
        [issue],
        [{ type: "performance", status: "unavailable", reason }],
        "info",
        width,
      );
      expect(output.split("\n").every((line) => stringWidth(line) <= width)).toBe(true);
      const renderedTitle = (
        width < 45
          ? (output.split("Issue:\n")[1]?.split("\nAffected:")[0] ?? "")
          : output
              .split("\n")
              .filter((line) => line.startsWith("│"))
              .slice(1)
              .map((line) => line.split("│")[3]?.trim() ?? "")
              .join("")
      ).replaceAll(/\s/gu, "");
      if (width < 45)
        expect(output).toContain("Severity:\n  warning\nCategory:\n  performance\nIssue:\n");
      expect(renderedTitle).toBe(
        title.replaceAll("\u001b", "\\u001b").replaceAll("\n", "\\u000a").replaceAll(/\s/gu, ""),
      );
      expect(output).not.toContain("\u001b");
      expect(output.replaceAll(/\s/gu, "")).toContain(
        reason.replaceAll("\u001b", "\\u001b").replaceAll(/\s/gu, ""),
      );
      expect(output.replaceAll(/\s+/gu, " ")).toContain(
        "Some checks are unavailable; results are incomplete.",
      );
    },
  );
});
