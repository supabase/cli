import { Context } from "effect";

export interface CliArgsShape {
  /** The argv the command parses, with a bare `--remote <word>` already joined where that is the only reading. */
  readonly args: ReadonlyArray<string>;
  /** The word a bare `--remote` is followed by when it was taken as an operand and could name a branch. */
  readonly bareRemoteOperand?: string | undefined;
  readonly remoteConflict?: boolean;
}

export class CliArgs extends Context.Service<CliArgs, CliArgsShape>()("supabase/cli/CliArgs") {}
