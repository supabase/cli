import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyFunctionsNew } from "./new.handler.ts";

const config = {
  functionName: Argument.string("Function name").pipe(
    Argument.withDescription("Name of the Function to create."),
  ),
  auth: Flag.choice("auth", ["none", "apikey", "user"] as const).pipe(
    Flag.withDescription("Use a specific auth mode."),
    Flag.withDefault("apikey" as const),
  ),
} as const;

export type LegacyFunctionsNewFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyFunctionsNewCommand = Command.make("new", config).pipe(
  Command.withDescription("Create a new Function locally."),
  Command.withShortDescription("Create a new Function locally"),
  Command.withHandler((flags) => legacyFunctionsNew(flags)),
);
