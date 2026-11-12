import { Context, Exit, Option, Schema } from "effect";
import { Command } from "effect/cli";

/** A command's declared machine result: the JSON value its `Output.success` or `Output.result` writes. */
export interface CommandOutputContract {
  readonly schema: Schema.Decoder<unknown>;
}

/** Context key under which a command's output contract is stored in `Command.annotations`. */
export class CommandOutputAnnotation extends Context.Service<
  CommandOutputAnnotation,
  CommandOutputContract
>()("supabase/CommandOutput") {}

/** Declares the JSON result shape described by `schema`. */
export const make = (schema: Schema.Decoder<unknown>): CommandOutputContract => ({ schema });

/** Annotates a command with its output contract; the handler and its writes are unchanged. */
export const withOutput = (contract: CommandOutputContract) =>
  Command.annotate(CommandOutputAnnotation, contract);

/**
 * Returns why a serialized result doesn't match the contract, or `None` when it does. Keys the
 * schema doesn't declare count as a mismatch.
 */
export const resultIssue = (
  contract: CommandOutputContract,
  json: string,
): Option.Option<string> => {
  const exit = Schema.decodeExit(Schema.fromJsonString(contract.schema), {
    onExcessProperty: "error",
  })(json);
  return Exit.isSuccess(exit) ? Option.none() : Option.some(String(exit.cause));
};
