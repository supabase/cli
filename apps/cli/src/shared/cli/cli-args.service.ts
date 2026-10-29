import { Context } from "effect";

export interface CliArgsShape {
  /** The parsed argv, with a bare `--remote <word>` joined where that is the only reading. */
  readonly args: ReadonlyArray<string>;
  readonly bareRemoteOperand?: string | undefined;
  readonly remoteConflict?: boolean;
}

export class CliArgs extends Context.Service<CliArgs, CliArgsShape>()("supabase/cli/CliArgs") {}
