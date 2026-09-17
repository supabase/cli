import { renderGlamourTable } from "./legacy-glamour-table.ts";
import type { Report, ReportBlock, ReportSeverity, ReportStepsBlock } from "./report.types.ts";

/**
 * Renders a `Report` for the terminal.
 *
 * Table blocks reuse `renderGlamourTable`, so a report containing only a table
 * renders byte-identically to the pre-report output — which is what makes the
 * adapter migration of the existing commands a no-op in text mode.
 *
 * No ANSI color: severity is carried by a symbol prefix, matching the plain
 * glamour AsciiStyle output the inspect commands already produce and keeping
 * piped/CI output clean.
 */
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

    case "sql":
      return [`  ${block.title}`, ...block.statements.map((s) => `    ${s}`)].join("\n") + "\n";

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
export function wrap(text: string, width: number): string[] {
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
