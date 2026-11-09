import { Context, Option } from "effect";
import type { HelpDoc } from "effect/cli";

export class OptionalSubcommand extends Context.Service<OptionalSubcommand, boolean>()(
  "supabase/OptionalSubcommand",
) {}

export const hasOptionalSubcommand = (command: {
  readonly annotations: Context.Context<never>;
}): boolean =>
  Option.getOrElse(Context.getOption(command.annotations, OptionalSubcommand), () => false);

export const withOptionalSubcommandUsage = (doc: HelpDoc.HelpDoc): HelpDoc.HelpDoc =>
  hasOptionalSubcommand(doc)
    ? { ...doc, usage: doc.usage.replace(" <subcommand>", " [subcommand]") }
    : doc;
