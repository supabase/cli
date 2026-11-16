import { Context, Option } from "effect";
import { Command } from "effect/cli";

/** The failure contract a command reports through: the `errors.standard` envelope or the legacy one. */
export type CommandErrorsContract = "standard" | "legacy";

/** Context key under which a command's error contract is stored in `Command.annotations`. */
export class CommandErrorsAnnotation extends Context.Service<
  CommandErrorsAnnotation,
  CommandErrorsContract
>()("supabase/CommandErrorsAnnotation") {}

/**
 * Reports the command's failures through the `errors.standard` envelope at the CLI error boundary;
 * the handler propagates failures instead of rendering them.
 */
export const withStandardErrors = <const Name extends string, Input, ContextInput, E, R>(
  self: Command.Command<Name, Input, ContextInput, E, R>,
) => self.pipe(Command.annotate(CommandErrorsAnnotation, "standard"));

/** A command without the standard marker reports through the legacy envelope. */
export const readCommandErrorsContract = (command: Command.Command.Any): CommandErrorsContract =>
  Option.getOrElse(Context.getOption(command.annotations, CommandErrorsAnnotation), () => "legacy");
