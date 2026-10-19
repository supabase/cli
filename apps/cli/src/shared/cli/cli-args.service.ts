import { Context } from "effect";

import type { RemoteArgvLeaf } from "./remote-argv.ts";

export interface CliArgsShape {
  readonly args: ReadonlyArray<string>;
  /** How the resolved command reads its operands; present only when argv holds a bare `--remote`. */
  readonly remoteLeaf?: RemoteArgvLeaf | undefined;
}

export class CliArgs extends Context.Service<CliArgs, CliArgsShape>()("supabase/cli/CliArgs") {}
