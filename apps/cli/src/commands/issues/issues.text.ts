import { renderTablewriter } from "../../command-internal/tabular-output.ts";
import { escapeControlCharacters } from "../../shared/output/escape-control-characters.ts";
import { wrapTerminalText } from "../../shared/output/wrap-terminal-text.ts";
import type { CheckCoverage, Issue, IssueSeverity } from "./issues.format.ts";

function renderIssueFields(issue: Issue, width: number): string {
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["Severity", issue.severity],
    ["Category", issue.category],
    ["Issue", issue.title || issue.id],
    ["Affected", String(issue.affected.length)],
  ];
  return fields
    .map(([label, value]) => {
      const content = wrapTerminalText(escapeControlCharacters(value), width - 2)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      return `${label}:\n${content}`;
    })
    .join("\n");
}

export function renderIssuesText(
  issues: ReadonlyArray<Issue>,
  checks: ReadonlyArray<CheckCoverage>,
  minimum: IssueSeverity,
  columns: number,
): string {
  const width = Number.isFinite(columns) && columns >= 20 ? Math.floor(columns) : 80;
  const severityWidth = Math.max(
    "Severity".length,
    ...issues.map((issue) => issue.severity.length),
  );
  const categoryWidth = Math.max(
    "Category".length,
    ...issues.map((issue) => issue.category.length),
  );
  const affectedWidth = Math.max(
    "Affected".length,
    ...issues.map((issue) => String(issue.affected.length).length),
  );
  const titleWidth = width - severityWidth - categoryWidth - affectedWidth - 13;
  const wrap = (text: string) => wrapTerminalText(escapeControlCharacters(text), width);
  const summary =
    issues.length === 0
      ? `No issues match --severity ${minimum}.`
      : `${issues.length} ${issues.length === 1 ? "issue" : "issues"} (${minimum} or higher).`;
  const findings =
    issues.length === 0
      ? ""
      : titleWidth < "Issue".length
        ? issues.map((issue) => renderIssueFields(issue, width)).join("\n\n") + "\n"
        : renderTablewriter(
            ["Severity", "Category", "Issue", "Affected"],
            issues.map((issue) => [
              issue.severity,
              issue.category,
              wrapTerminalText(escapeControlCharacters(issue.title || issue.id), titleWidth),
              String(issue.affected.length),
            ]),
            (value) => String(value),
          );
  const coverage = checks.map((check) =>
    wrap(`${check.type}: ${check.status}${check.reason === undefined ? "" : ` — ${check.reason}`}`),
  );
  const incomplete = checks.some((check) => check.status === "unavailable")
    ? `${wrap("Some checks are unavailable; results are incomplete.")}\n`
    : "";
  const hint = wrap(
    "Use --output-format json for affected resources, evidence, and remediation links.",
  );
  return `${wrap(summary)}\n${findings}\nChecks\n${coverage.join("\n")}\n${incomplete}\n${hint}\n`;
}
