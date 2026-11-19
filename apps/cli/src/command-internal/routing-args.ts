import { extractCommandPath, hasRootVersionFlag } from "../shared/cli/run.ts";

const isCompletionToken = (arg: string | undefined): boolean =>
  arg === "__complete" || arg === "__completeNoDesc";

/**
 * Splits argv into the args and command path that backend and feature routing read, or
 * `undefined` for `--version`. Completion passes the final token as the cursor word, so it is
 * dropped from both.
 */
export const routingArgsFor = (
  args: ReadonlyArray<string>,
):
  | { readonly routingArgs: ReadonlyArray<string>; readonly path: ReadonlyArray<string> }
  | undefined => {
  const routingArgs = isCompletionToken(args[0]) ? args.slice(0, -1) : args;
  if (hasRootVersionFlag(routingArgs)) return undefined;
  const commandPath = extractCommandPath(routingArgs);
  return {
    routingArgs,
    path: isCompletionToken(commandPath[0]) ? commandPath.slice(1) : commandPath,
  };
};
