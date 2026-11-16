import { Context, Option } from "effect";
import { Command } from "effect/cli";

/**
 * How far a command's contract has settled. An experimental command is reachable only while its
 * `feature` is enabled: the root mounts the command's family only then.
 */
export interface CommandStage {
  readonly status: "experimental";
  readonly feature: string;
}

/** Context key under which a command's stage is stored in `Command.annotations`. */
export class CommandStageAnnotation extends Context.Service<CommandStageAnnotation, CommandStage>()(
  "supabase/CommandStageAnnotation",
) {}

/** Declares the command's stage. */
export const withCommandStage =
  (stage: CommandStage) =>
  <const Name extends string, Input, ContextInput, E, R>(
    self: Command.Command<Name, Input, ContextInput, E, R>,
  ) =>
    self.pipe(Command.annotate(CommandStageAnnotation, stage));

/** The stage a command declares, or `None` for a stable command. */
export const readCommandStage = (command: Command.Command.Any): Option.Option<CommandStage> =>
  Context.getOption(command.annotations, CommandStageAnnotation);
