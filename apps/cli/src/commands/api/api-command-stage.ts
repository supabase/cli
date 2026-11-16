import { Context, Effect, Option } from "effect";
import { Command } from "effect/cli";

import { requireExperimental } from "../../command-internal/experimental-gate.ts";

/**
 * How far a command's contract has settled. An experimental command is reachable only through its
 * `gate`: the `--experimental` flag, or an experimental feature whose family mounts the command.
 */
export interface CommandStage {
  readonly status: "experimental";
  readonly gate: { readonly kind: "flag" } | { readonly kind: "feature"; readonly feature: string };
}

/** Context key under which a command's stage is stored in `Command.annotations`. */
export class CommandStageAnnotation extends Context.Service<CommandStageAnnotation, CommandStage>()(
  "supabase/CommandStageAnnotation",
) {}

/** Declares the command's stage; install it together with {@link enforceStage} in the handler. */
export const withCommandStage =
  (stage: CommandStage) =>
  <const Name extends string, Input, ContextInput, E, R>(
    self: Command.Command<Name, Input, ContextInput, E, R>,
  ) =>
    self.pipe(Command.annotate(CommandStageAnnotation, stage));

/** The stage a command declares, or `None` for a stable command. */
export const readCommandStage = (command: Command.Command.Any): Option.Option<CommandStage> =>
  Context.getOption(command.annotations, CommandStageAnnotation);

/**
 * Enforces a stage before any other effect. A feature gate is satisfied by the family being
 * mounted: the root only mounts a feature's commands while the feature is enabled.
 */
export const enforceStage = (stage: CommandStage) =>
  stage.gate.kind === "flag" ? requireExperimental : Effect.void;
