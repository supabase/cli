import { Flag } from "effect/unstable/cli";

/**
 * `--no-descriptions` flag shared by all four completion subcommands.
 *
 * `Flag.Boolean` auto-derives a `--no-no-descriptions` negation from the name, which
 * harmlessly resolves back to the same `false` default.
 */
export const CompletionNoDescriptionsFlagDef = Flag.Boolean("no-descriptions").pipe(
  Flag.withDescription("disable completion descriptions"),
  Flag.withDefault(false),
);
