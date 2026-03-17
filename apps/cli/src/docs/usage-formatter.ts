import { Option } from "effect";
import type { Command, HelpDoc } from "effect/unstable/cli";
import { findCommand, getHelpDoc } from "./command-docs.ts";

function escapeKdl(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function indent(level: number): string {
  return "  ".repeat(level);
}

function formatFlag(flag: HelpDoc.FlagDoc, level: number, global = false): string {
  const parts: string[] = [];
  for (const alias of flag.aliases) {
    parts.push(alias);
  }
  parts.push(`--${flag.name}`);

  if (flag.type !== "boolean") {
    parts.push(`<${flag.name}>`);
  }

  const flagStr = parts.join(" ");
  const attrs: string[] = [];
  const description = Option.getOrUndefined(flag.description);
  if (description) {
    attrs.push(`help="${escapeKdl(description)}"`);
  }
  if (flag.required) {
    attrs.push("required=#true");
  }
  if (global) {
    attrs.push("global=#true");
  }

  const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  return `${indent(level)}flag "${flagStr}"${attrStr}`;
}

function formatArg(arg: HelpDoc.ArgDoc, level: number): string {
  let name: string;
  if (arg.required) {
    name = arg.variadic ? `<${arg.name}...>` : `<${arg.name}>`;
  } else {
    name = arg.variadic ? `[${arg.name}...]` : `[${arg.name}]`;
  }

  const attrs: string[] = [];
  const description = Option.getOrUndefined(arg.description);
  if (description) {
    attrs.push(`help="${escapeKdl(description)}"`);
  }

  const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  return `${indent(level)}arg "${name}"${attrStr}`;
}

function formatExample(example: HelpDoc.ExampleDoc, level: number): string {
  const lines: string[] = [];
  lines.push(`${indent(level)}example {`);
  if (example.description) {
    lines.push(`${indent(level + 1)}header "${escapeKdl(example.description)}"`);
  }
  lines.push(`${indent(level + 1)}code "${escapeKdl(example.command)}"`);
  lines.push(`${indent(level)}}`);
  return lines.join("\n");
}

function formatSubcommand(
  root: Command.Command.Any,
  name: string,
  shortDescription: string | undefined,
  level: number,
): string {
  const sub = findCommand(root, [name]);
  if (!sub) {
    const help = shortDescription ? ` help="${escapeKdl(shortDescription)}"` : "";
    return `${indent(level)}cmd "${name}"${help}`;
  }

  const helpDoc = getHelpDoc(sub, [name]);
  const help = shortDescription ? ` help="${escapeKdl(shortDescription)}"` : "";

  const children: string[] = [];

  if (helpDoc.description) {
    children.push(`${indent(level + 1)}long_help "${escapeKdl(helpDoc.description)}"`);
  }

  for (const flag of helpDoc.flags) {
    children.push(formatFlag(flag, level + 1));
  }

  if (helpDoc.args) {
    for (const arg of helpDoc.args) {
      children.push(formatArg(arg, level + 1));
    }
  }

  if (helpDoc.examples) {
    for (const example of helpDoc.examples) {
      children.push(formatExample(example, level + 1));
    }
  }

  if (helpDoc.subcommands) {
    for (const group of helpDoc.subcommands) {
      for (const cmd of group.commands) {
        children.push(
          formatSubcommand(sub, cmd.name, cmd.shortDescription ?? cmd.description, level + 1),
        );
      }
    }
  }

  if (children.length === 0) {
    return `${indent(level)}cmd "${name}"${help}`;
  }

  return `${indent(level)}cmd "${name}"${help} {\n${children.join("\n")}\n${indent(level)}}`;
}

export function formatAsUsageSpec(
  command: Command.Command.Any,
  options: { version: string },
): string {
  const helpDoc = getHelpDoc(command, [command.name]);
  const lines: string[] = [];

  lines.push(`bin "${command.name}"`);

  if (helpDoc.description) {
    const firstLine = helpDoc.description.split("\n")[0]!;
    if (firstLine !== helpDoc.description) {
      lines.push(`about "${escapeKdl(firstLine)}"`);
      lines.push(`long_about "${escapeKdl(helpDoc.description)}"`);
    } else {
      lines.push(`about "${escapeKdl(helpDoc.description)}"`);
    }
  }

  lines.push(`version "${escapeKdl(options.version)}"`);

  if (helpDoc.globalFlags) {
    for (const flag of helpDoc.globalFlags) {
      lines.push(formatFlag(flag, 0, true));
    }
  }

  for (const flag of helpDoc.flags) {
    lines.push(formatFlag(flag, 0));
  }

  if (helpDoc.args) {
    for (const arg of helpDoc.args) {
      lines.push(formatArg(arg, 0));
    }
  }

  if (helpDoc.examples) {
    for (const example of helpDoc.examples) {
      lines.push(formatExample(example, 0));
    }
  }

  if (helpDoc.subcommands) {
    for (const group of helpDoc.subcommands) {
      for (const cmd of group.commands) {
        lines.push(formatSubcommand(command, cmd.name, cmd.shortDescription ?? cmd.description, 0));
      }
    }
  }

  return lines.join("\n");
}
