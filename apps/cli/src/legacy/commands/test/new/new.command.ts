import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyTestNew } from "./new.handler.ts";

const TEMPLATE_VALUES = ["pgtap"] as const;

const config = {
  name: Argument.string("name").pipe(Argument.withDescription("Name of the test file to create.")),
  template: Flag.choice("template", TEMPLATE_VALUES).pipe(
    Flag.withAlias("t"),
    Flag.withDescription("Template framework to generate."),
    Flag.optional,
  ),
} as const;

export type LegacyTestNewFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyTestNewCommand = Command.make("new", config).pipe(
  Command.withDescription("Create a new test file."),
  Command.withShortDescription("Create a new test file"),
  Command.withHandler((flags) => legacyTestNew(flags)),
);
