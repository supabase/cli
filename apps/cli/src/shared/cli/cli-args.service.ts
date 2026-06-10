import { Context } from "effect";

export interface CliArgsShape {
  readonly args: ReadonlyArray<string>;
}

export class CliArgs extends Context.Service<CliArgs, CliArgsShape>()("supabase/cli/CliArgs") {}
