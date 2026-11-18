import { Context, Option } from "effect";
import { Command } from "effect/cli";

import { requireExperimental } from "../experimental-gate.ts";

/** A command's release stage. Only `experimental` is gated today. */
export interface CommandStage {
  readonly stage: "experimental";
}

/** The release stage declared by {@link withStage}. */
export class CommandStageAnnotation extends Context.Service<CommandStageAnnotation, CommandStage>()(
  "supabase/CommandStage",
) {}

/**
 * Declares a leaf's release stage and installs its gate: an experimental leaf fails with
 * `ExperimentalRequiredError` before its handler and handler layers run unless `--experimental`
 * is set. Apply it after every `Command.provide` so the gate runs before those layers build.
 * A later `Command.provideEffectDiscard` runs before the gate.
 */
export const withStage =
  (stage: CommandStage) =>
  <const Name extends string, Input, ContextInput, E, R>(
    self: Command.Command<Name, Input, ContextInput, E, R>,
  ) =>
    self.pipe(
      Command.annotate(CommandStageAnnotation, stage),
      Command.provideEffectDiscard(requireExperimental),
    );

export const readStage = (command: Command.Command.Any): Option.Option<CommandStage> =>
  Context.getOption(command.annotations, CommandStageAnnotation);
