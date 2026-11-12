import { describe, expect, it } from "vitest";
import { stringWidth } from "../../command-internal/string-width.ts";
import type { Issue } from "./issues.format.ts";
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
    },
  ],
};

describe("readable issue tables", () => {
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
