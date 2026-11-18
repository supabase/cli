import { Context, Option } from "effect";
import type { Schema } from "effect";
import { Command, type GlobalFlag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import type { Output } from "../../shared/output/output.service.ts";
import { readPermissions } from "../command-permissions/command-permissions.annotation.ts";
import { managementApiGuardLayer } from "./management-api-guard.ts";

type ErrorClass = abstract new (...args: never) => unknown;
type InstanceOf<C> = C extends abstract new (...args: never) => infer I ? I : never;
type InputKey<Input> = Extract<keyof Input, string>;

// `GlobalFlag.Setting` is invariant in its id through `Context.Service`, so match it structurally.
interface AnyGlobalFlag {
  readonly _tag: "Setting";
  readonly id: string;
}
type GlobalFlagServices<R> = Extract<R, GlobalFlag.Setting.Identifier<string>>;
type DeclaredGlobalFlags<G extends ReadonlyArray<AnyGlobalFlag>> = GlobalFlag.Setting.Identifier<
  G[number]["id"]
>;

/** Resolves to `unknown` when the command requires exactly the declared global flags. */
type GlobalFlagCheck<R, G extends ReadonlyArray<AnyGlobalFlag>> = [
  Exclude<GlobalFlagServices<R>, DeclaredGlobalFlags<G>>,
  Exclude<DeclaredGlobalFlags<G>, GlobalFlagServices<R>>,
] extends [never, never]
  ? unknown
  : {
      readonly undeclaredGlobalFlags: Exclude<GlobalFlagServices<R>, DeclaredGlobalFlags<G>>;
      readonly unusedGlobalFlags: Exclude<DeclaredGlobalFlags<G>, GlobalFlagServices<R>>;
    };

/** The result of a successful run in each output mode. */
export interface ContractOutput {
  /** The `success` event's data in `json` and `stream-json` modes. */
  readonly data: Schema.Top;
  readonly text: {
    readonly stream: "stdout" | "stderr";
    readonly example: string;
  };
}

/** A failure the command can return; its error code is the class's `_tag`. */
export interface ContractError {
  readonly error: ErrorClass;
  readonly when: string;
  /** Omit when the error already carries its own suggestion. */
  readonly nextStep?: string;
}

/** Where a write's target parameter may come from. */
export type ContractWriteTarget<Key extends string = string> =
  | { readonly from: "input"; readonly input: Key; readonly when: string }
  | {
      readonly from: "lookup";
      readonly operationId: string;
      readonly field: string;
      readonly when: string;
    };

/** A Management API write, the parameter that names its target, and how many times it may run. */
export interface ContractWrite<Key extends string = string> {
  readonly operationId: string;
  readonly targetParam: string;
  readonly targets: ReadonlyArray<ContractWriteTarget<Key>>;
  readonly max: number;
}

/** What the docs need that the command tree can't supply. */
export interface ContractPresentation {
  readonly examples: ReadonlyArray<CliCommand.Command.Example>;
}

/**
 * A command's declared input, global flags, output, errors, writes and
 * presentation. The command is built from `input` with `Command.make`; reads stay in
 * `withPermissions`.
 */
export interface CommandContract<
  Input extends CliCommand.Command.Config = CliCommand.Command.Config,
  Errors extends ReadonlyArray<ContractError> = ReadonlyArray<ContractError>,
  GlobalFlags extends ReadonlyArray<AnyGlobalFlag> = ReadonlyArray<AnyGlobalFlag>,
> {
  /** The command's flags and arguments, passed to `Command.make`. */
  readonly input: Input;
  /** The global flags the command or its layers require as services. */
  readonly globalFlags: GlobalFlags;
  readonly output: ContractOutput;
  readonly errors: Errors;
  readonly writes: ReadonlyArray<ContractWrite<InputKey<Input>>>;
  readonly presentation: ContractPresentation;
}

/** Declares a contract, checking that its references to input name keys of `input`. */
export const defineContract = <
  const Input extends CliCommand.Command.Config,
  const Errors extends ReadonlyArray<ContractError>,
  const GlobalFlags extends ReadonlyArray<AnyGlobalFlag>,
>(
  contract: CommandContract<Input, Errors, GlobalFlags>,
): CommandContract<Input, Errors, GlobalFlags> => contract;

/** The parsed flags and arguments a handler receives for a contract's input. */
export type ContractInput<C extends { readonly input: CliCommand.Command.Config }> =
  CliCommand.Command.Config.Infer<C["input"]>;

/** Context key under which a command's contract is stored in `Command.annotations`. */
export class CommandContractAnnotation extends Context.Service<
  CommandContractAnnotation,
  CommandContract
>()("supabase/CommandContract") {}

/**
 * Attaches a contract to a command, sets its help examples, and guards its Management API
 * requests at runtime. Apply it last in the pipe: a command whose input differs from
 * the contract's, whose handler can fail with an error the contract doesn't list, or whose
 * required global flags differ from the declared ones fails to compile.
 */
export const withContract =
  <
    Input extends CliCommand.Command.Config,
    Errors extends ReadonlyArray<ContractError>,
    GlobalFlags extends ReadonlyArray<AnyGlobalFlag>,
  >(
    contract: CommandContract<Input, Errors, GlobalFlags>,
  ) =>
  <Name extends string, ContextInput, E extends InstanceOf<Errors[number]["error"]>, R>(
    self: Command.Command<Name, CliCommand.Command.Config.Infer<Input>, ContextInput, E, R> &
      GlobalFlagCheck<R, GlobalFlags>,
  ): Command.Command<Name, CliCommand.Command.Config.Infer<Input>, ContextInput, E, R | Output> => {
    // `keyof Input` makes `CommandContract` invariant in `Input`; rebuilding it checks each field.
    const stored: CommandContract = {
      input: contract.input,
      globalFlags: contract.globalFlags,
      output: contract.output,
      errors: contract.errors,
      writes: contract.writes,
      presentation: contract.presentation,
    };
    const permissions = readPermissions(self);
    return self.pipe(
      Command.provide((input) => managementApiGuardLayer(stored, permissions, input)),
      Command.withExamples(contract.presentation.examples),
      Command.annotate(CommandContractAnnotation, stored),
    );
  };

/** The contract declared on `command` with {@link withContract}, or none. */
export function readContract(command: Command.Command.Any): Option.Option<CommandContract> {
  return Context.getOption(command.annotations, CommandContractAnnotation);
}
