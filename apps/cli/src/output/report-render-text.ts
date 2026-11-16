import { renderGlamourTable } from "./glamour-table.ts";
import type { Report, ReportBlock, ReportSeverity, ReportStepsBlock } from "./report.types.ts";

/** Renders a `Report` as plain terminal text; severity is a symbol prefix, not ANSI color. */
export function renderReportText(report: Report): string {
  const parts = report.blocks.map(renderBlock);
  return "\n" + parts.join("\n") + "\n";
}

const SEVERITY_SYMBOL: Record<ReportSeverity, string> = {
  info: "ℹ",
  ok: "✓",
  warn: "⚠",
  critical: "✗",
};

const WRAP_WIDTH = 72;

function renderBlock(block: ReportBlock): string {
  switch (block.kind) {
    case "keyValue": {
      const width = Math.max(...block.entries.map((e) => e.key.length));
      return block.entries.map((e) => `  ${e.key.padEnd(width)} : ${e.value}`).join("\n") + "\n";
    }

    case "table": {
      const hasSeverity = block.rows.some((r) => r.severity !== undefined);
      const headers = hasSeverity
        ? ["", ...block.columns.map((c) => c.title)]
        : block.columns.map((c) => c.title);
      const cells = block.rows.map((r) =>
        hasSeverity
          ? [r.severity === undefined ? "" : SEVERITY_SYMBOL[r.severity], ...r.cells]
          : [...r.cells],
      );
      return renderGlamourTable(headers, cells);
    }

    case "callout":
      return (
        wrap(block.text, WRAP_WIDTH)
          .map((line, i) =>
            i === 0 ? `  ${SEVERITY_SYMBOL[block.severity]}  ${line}` : `     ${line}`,
          )
          .join("\n") + "\n"
      );

    case "steps":
      return renderSteps(block);
  }
}

function renderSteps(block: ReportStepsBlock): string {
  const lines: string[] = [];
  block.steps.forEach((step, i) => {
    lines.push(`  ${i + 1}. ${step.title}`);
    if (step.body !== undefined) {
      for (const line of wrap(step.body, WRAP_WIDTH)) lines.push(`     ${line}`);
    }
    if (step.sql !== undefined) {
      lines.push("");
      for (const statement of step.sql) lines.push(`       ${statement}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

/** Greedy word wrap; preserves words longer than the width intact. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/ +/)) {
      if (word === "") continue;
      if (line === "") line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}
