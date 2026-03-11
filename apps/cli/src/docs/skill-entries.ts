import type { Command } from "effect/unstable/cli";

import { collectCommands, findCommand, getHelpDoc } from "./command-docs.ts";
import { injectSections } from "./guide-injector.ts";
import { getGuide } from "./guide-registry.ts";
import { formatHelpDocAsMarkdown } from "./markdown-formatter.ts";

interface SkillEntry {
  readonly skillName: string;
  readonly skillDescription: string;
  readonly content: string;
}

export function buildSkillEntries(
  command: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
): Array<SkillEntry> {
  const target = findCommand(command, commandPath.slice(1)) ?? command;
  const leaves = collectCommands(target, commandPath).filter(
    ({ command: cmd }) => cmd.subcommands.length === 0,
  );

  return leaves.map(({ command: cmd, commandPath: cmdPath }) => {
    const helpDoc = getHelpDoc(cmd, cmdPath);
    const guide = getGuide(cmdPath.slice(1));
    const content = guide
      ? injectSections(guide.template, helpDoc)
      : formatHelpDocAsMarkdown(helpDoc);

    return {
      skillName: guide?.skillName ?? cmdPath.join("-"),
      skillDescription: guide?.skillDescription ?? (cmd as any).shortDescription ?? "",
      content,
    };
  });
}
