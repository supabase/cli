import { Context, Layer, Option } from "effect";
import { Command } from "effect/cli";

export type TargetGroup = "local-only" | "account" | "hosted" | "selectable" | "removed";

export interface TargetPolicyShape {
  readonly group: TargetGroup;
  readonly consent: "none" | "no" | "yes";
  readonly consentExemptReason?: string | undefined;
}

/**
 * What a leaf declares. `consentExemptReason` explains why a leaf never asks for hosted-mutation
 * consent; a `selectable` leaf must give one because it can reach a hosted database.
 */
export type TargetPolicyDeclaration =
  | {
      readonly group: "selectable";
      readonly consent: "none";
      readonly consentExemptReason: string;
    }
  | {
      readonly group: Exclude<TargetGroup, "selectable">;
      readonly consent: "none";
      readonly consentExemptReason?: string;
    }
  | {
      readonly group: TargetGroup;
      readonly consent: "no" | "yes";
      readonly consentExemptReason?: never;
    };

/** The command's target group and hosted-mutation consent default, provided to its handler. */
export class TargetPolicy extends Context.Service<TargetPolicy, TargetPolicyShape>()(
  "supabase/TargetPolicy",
) {}

/** Context key under which a command's policy is stored in `Command.annotations`. */
export class TargetPolicyAnnotation extends Context.Service<
  TargetPolicyAnnotation,
  TargetPolicyShape
>()("supabase/TargetPolicyAnnotation") {}

/**
 * Declares a leaf's target group and consent default; apply it after the leaf's handler and its
 * other `Command.provide` layers so every one of them can read `TargetPolicy`.
 */
export const withTargetPolicy =
  (policy: TargetPolicyDeclaration) =>
  <const Name extends string, Input, ContextInput, E, R>(
    self: Command.Command<Name, Input, ContextInput, E, R>,
  ) =>
    self.pipe(
      Command.annotate(TargetPolicyAnnotation, policy),
      Command.provide(Layer.succeed(TargetPolicy, policy)),
    );

export const readTargetPolicy = (command: Command.Command.Any): Option.Option<TargetPolicyShape> =>
  Context.getOption(command.annotations, TargetPolicyAnnotation);
