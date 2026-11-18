import { Array as Arr, Option } from "effect";
import type { HelpDoc } from "effect/cli";

import { renderDescriptionMarkdown } from "./description-markdown.ts";

/** Renders description fields without changing source metadata or help syntax. */
export function withHelpMarkdown(doc: HelpDoc.HelpDoc, colors: boolean): HelpDoc.HelpDoc {
  const render = (text: string) => renderDescriptionMarkdown(text, colors);
  const flag = (value: HelpDoc.FlagDoc): HelpDoc.FlagDoc => ({
    ...value,
    description: Option.map(value.description, render),
  });
  return {
    ...doc,
    description: render(doc.description),
    flags: doc.flags.map(flag),
    ...(doc.inheritedFlags === undefined ? {} : { inheritedFlags: doc.inheritedFlags.map(flag) }),
    ...(doc.globalFlags === undefined ? {} : { globalFlags: doc.globalFlags.map(flag) }),
    ...(doc.args === undefined
      ? {}
      : {
          args: doc.args.map((arg) => ({
            ...arg,
            description: Option.map(arg.description, render),
          })),
        }),
    ...(doc.subcommands === undefined
      ? {}
      : {
          subcommands: doc.subcommands.map((group) => ({
            ...group,
            commands: Arr.map(group.commands, (command) => {
              const rendered = { ...command, description: render(command.description) };
              if (command.shortDescription === undefined) return rendered;
              return { ...rendered, shortDescription: render(command.shortDescription) };
            }),
          })),
        }),
    ...(doc.examples === undefined
      ? {}
      : {
          examples: doc.examples.map((example) => {
            if (example.description === undefined) return { ...example };
            return { ...example, description: render(example.description) };
          }),
        }),
  };
}
