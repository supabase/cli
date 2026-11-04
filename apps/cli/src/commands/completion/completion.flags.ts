import { Flag } from "effect/cli";
import { cliFlag } from "../../shared/cli/cli-params.ts";

/**
 * `--no-descriptions` flag shared by all four completion subcommands.
 *
 * `Flag.Boolean` auto-derives a `--no-no-descriptions` negation from the name, which
 * harmlessly resolves back to the same `false` default.
 */
export const CompletionNoDescriptionsFlagDef = cliFlag("no-descriptions", Flag.Boolean, {
  description: "Omit descriptions from the generated completions.",
  default: false,
});
