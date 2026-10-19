import { Context } from "effect";

export interface CliArgsShape {
  /** The argv the command parses, with a bare `--remote <word>` already joined where that is the only reading. */
  readonly args: ReadonlyArray<string>;
  /** The word a bare `--remote` is followed by when it was taken as an operand and could name a branch. */
  readonly bareRemoteOperand?: string | undefined;
  /** The operand placeholders the resolved command's help lists, e.g. `<NAME=VALUE>...`; read lazily, only a warning needs them. */
  readonly operandPlaceholders?: (() => ReadonlyArray<string>) | undefined;
}

export class CliArgs extends Context.Service<CliArgs, CliArgsShape>()("supabase/cli/CliArgs") {}
