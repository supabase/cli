import { Option } from "effect";
import type { HelpDoc } from "effect/unstable/cli";
import { formatTable } from "./markdown-formatter.ts";

type MarkerSection = "USAGE" | "FLAGS" | "ARGS" | "EXAMPLES" | "SUBCOMMANDS";

const ALL_SECTIONS: MarkerSection[] = ["USAGE", "FLAGS", "ARGS", "EXAMPLES", "SUBCOMMANDS"];

export function formatSection(doc: HelpDoc.HelpDoc, section: MarkerSection): string | undefined {
  switch (section) {
    case "USAGE":
      return `## Usage\n\n\`\`\`sh\n${doc.usage}\n\`\`\``;

    case "ARGS": {
      if (!doc.args || doc.args.length === 0) return undefined;
      const rows = doc.args.map((arg) => {
        const name = arg.variadic ? `\`${arg.name}...\`` : `\`${arg.name}\``;
        return [
          name,
          `\`${arg.type}\``,
          arg.required ? "Yes" : "No",
          Option.getOrUndefined(arg.description) ?? "",
        ];
      });
      return `## Arguments\n\n${formatTable(["Argument", "Type", "Required", "Description"], rows)}`;
    }

    case "FLAGS": {
      if (doc.flags.length === 0) return undefined;
      const rows = doc.flags.map((flag) => {
        const names = [`--${flag.name}`, ...flag.aliases].map((n) => `\`${n}\``).join(", ");
        return [names, `\`${flag.type}\``, Option.getOrUndefined(flag.description) ?? ""];
      });
      return `## Flags\n\n${formatTable(["Flag", "Type", "Description"], rows)}`;
    }

    case "EXAMPLES": {
      if (!doc.examples || doc.examples.length === 0) return undefined;
      const exampleBlocks = doc.examples.map((example) => {
        const block = `\`\`\`sh\n${example.command}\n\`\`\``;
        return example.description ? `${example.description}\n\n${block}` : block;
      });
      return `## Examples\n\n${exampleBlocks.join("\n\n")}`;
    }

    case "SUBCOMMANDS": {
      if (!doc.subcommands || doc.subcommands.length === 0) return undefined;
      const subcommandSections: string[] = [];
      for (const group of doc.subcommands) {
        const rows = group.commands.map((sub) => [
          `\`${sub.name}\``,
          sub.shortDescription ?? sub.description,
        ]);
        const table = formatTable(["Command", "Description"], rows);
        if (group.group) {
          subcommandSections.push(`### ${group.group}\n\n${table}`);
        } else {
          subcommandSections.push(table);
        }
      }
      return `## Subcommands\n\n${subcommandSections.join("\n\n")}`;
    }
  }
}

export function injectSections(guideTemplate: string, doc: HelpDoc.HelpDoc): string {
  let result = guideTemplate;
  for (const section of ALL_SECTIONS) {
    const startMarker = `<!-- ${section}:START -->`;
    const endMarker = `<!-- ${section}:END -->`;
    const startIndex = result.indexOf(startMarker);
    const endIndex = result.indexOf(endMarker);
    if (startIndex === -1 || endIndex === -1) continue;
    const rendered = formatSection(doc, section);
    const replacement = rendered ? `\n\n${rendered}\n\n` : "";
    result =
      result.slice(0, startIndex + startMarker.length) + replacement + result.slice(endIndex);
  }
  return result;
}
