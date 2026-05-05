import { Option } from "effect";
import type { HelpDoc } from "effect/unstable/cli";

function escapeMdxText(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);

  const headerLine = `| ${headers.map((h, i) => pad(h, widths[i]!)).join(" | ")} |`;
  const separatorLine = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const dataLines = rows.map(
    (row) => `| ${row.map((cell, i) => pad(cell, widths[i]!)).join(" | ")} |`,
  );

  return [headerLine, separatorLine, ...dataLines].join("\n");
}

export function formatHelpDocAsMarkdown(doc: HelpDoc.HelpDoc): string {
  const sections: string[] = [];

  if (doc.description) {
    sections.push(escapeMdxText(doc.description));
  }

  sections.push(`## Usage\n\n\`\`\`sh\n${doc.usage}\n\`\`\``);

  if (doc.args && doc.args.length > 0) {
    const rows = doc.args.map((arg) => {
      const name = arg.variadic ? `\`${arg.name}...\`` : `\`${arg.name}\``;
      return [
        name,
        `\`${arg.type}\``,
        arg.required ? "Yes" : "No",
        escapeMdxText(Option.getOrUndefined(arg.description) ?? ""),
      ];
    });
    sections.push(
      `## Arguments\n\n${formatTable(["Argument", "Type", "Required", "Description"], rows)}`,
    );
  }

  if (doc.flags.length > 0) {
    const rows = doc.flags.map((flag) => {
      const names = [`--${flag.name}`, ...flag.aliases].map((n) => `\`${n}\``).join(", ");
      return [
        names,
        `\`${flag.type}\``,
        escapeMdxText(Option.getOrUndefined(flag.description) ?? ""),
      ];
    });
    sections.push(`## Flags\n\n${formatTable(["Flag", "Type", "Description"], rows)}`);
  }

  if (doc.examples && doc.examples.length > 0) {
    const exampleBlocks = doc.examples.map((example) => {
      const block = `\`\`\`sh\n${example.command}\n\`\`\``;
      return example.description ? `${escapeMdxText(example.description)}\n\n${block}` : block;
    });
    sections.push(`## Examples\n\n${exampleBlocks.join("\n\n")}`);
  }

  if (doc.subcommands && doc.subcommands.length > 0) {
    const subcommandSections: string[] = [];
    for (const group of doc.subcommands) {
      const rows = group.commands.map((sub) => [
        `\`${sub.name}\``,
        escapeMdxText(sub.shortDescription ?? sub.description),
      ]);
      const table = formatTable(["Command", "Description"], rows);
      if (group.group) {
        subcommandSections.push(`### ${group.group}\n\n${table}`);
      } else {
        subcommandSections.push(table);
      }
    }
    sections.push(`## Subcommands\n\n${subcommandSections.join("\n\n")}`);
  }

  return sections.join("\n\n");
}
