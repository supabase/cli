import { Command } from "effect/cli";
import type { GlobalFlag } from "effect/cli";

// oxlint-disable-next-line typescript/no-explicit-any -- Setting is invariant in its id and value
type AnySetting = GlobalFlag.Setting<any, any>;

type GlobalFlagIds<R> = Extract<R, GlobalFlag.Setting.Identifier<string>>;

type DeclaredIds<Flags extends ReadonlyArray<AnySetting>> = Flags[number] extends infer F
  ? F extends GlobalFlag.Setting<infer Id, infer _A>
    ? GlobalFlag.Setting.Identifier<Id>
    : never
  : never;

type GlobalFlagsCheck<Flags extends ReadonlyArray<AnySetting>, R> = [
  Exclude<GlobalFlagIds<R>, DeclaredIds<Flags>>,
  Exclude<DeclaredIds<Flags>, GlobalFlagIds<R>>,
] extends [never, never]
  ? unknown
  : {
      readonly undeclaredGlobalFlags: Exclude<GlobalFlagIds<R>, DeclaredIds<Flags>>;
      readonly unreadGlobalFlags: Exclude<DeclaredIds<Flags>, GlobalFlagIds<R>>;
    };

/**
 * Declares the global flags a leaf reads, through `Command.withGlobalFlags`. Fails to compile when
 * the leaf reads a global flag it doesn't list or lists one it never reads. Apply it last, after
 * every `Command.provide`, so layer requirements count as reads.
 */
export const withGlobalFlagsRead =
  <const Flags extends ReadonlyArray<AnySetting>>(flags: Flags) =>
  <Name extends string, Input, ContextInput, E, R>(
    self: Command.Command<Name, Input, ContextInput, E, R> & GlobalFlagsCheck<Flags, R>,
  ) =>
    Command.withGlobalFlags(self, flags);
