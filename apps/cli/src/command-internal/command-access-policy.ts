import { Context, Option } from "effect";
import { Command } from "effect/cli";

/** Documentation requirement paired with the check that enforces experimental access. */
export class ExperimentalAccessAnnotation extends Context.Service<
  ExperimentalAccessAnnotation,
  "required" | "optional"
>()("supabase/ExperimentalAccessAnnotation") {}

export const defineExperimentalAccess = <Check>(policy: {
  readonly experimental: "required" | "optional";
  readonly check: Check;
}) => ({
  check: policy.check,
  annotate: Command.annotate(ExperimentalAccessAnnotation, policy.experimental),
});

export const readExperimentalAccess = (command: Command.Command.Any) =>
  Context.getOption(command.annotations, ExperimentalAccessAnnotation);

/** Marks commands that remain in help but are excluded from the published reference. */
export class DeprecatedCommandAnnotation extends Context.Service<
  DeprecatedCommandAnnotation,
  true
>()("supabase/DeprecatedCommandAnnotation") {}

export const withDeprecated = Command.annotate(DeprecatedCommandAnnotation, true);

export const isDeprecated = (command: Command.Command.Any): boolean =>
  Option.isSome(Context.getOption(command.annotations, DeprecatedCommandAnnotation));

export function deprecatedShortDescription(command: Command.Command.Any): string | undefined {
  if (!isDeprecated(command)) return undefined;
  const base = command.shortDescription ?? command.description?.split("\n")[0] ?? "";
  return `${base} (deprecated)`;
}
