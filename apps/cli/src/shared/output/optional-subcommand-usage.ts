import { Context, Option } from "effect";
import type { HelpDoc } from "effect/cli";

export class OptionalSubcommand extends Context.Service<OptionalSubcommand, boolean>()(
  "supabase/OptionalSubcommand",
) {}

export const withOptionalSubcommandUsage = (doc: HelpDoc.HelpDoc): HelpDoc.HelpDoc =>
  Option.getOrElse(Context.getOption(doc.annotations, OptionalSubcommand), () => false)
    ? { ...doc, usage: doc.usage.replace(" <subcommand>", " [subcommand]") }
    : doc;
