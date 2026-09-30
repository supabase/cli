import {
  shellQuoteArgument,
  type ShellPlatform,
} from "../../../../command-internal/shell-quote.ts";

export interface StatusEnvPointerInput {
  readonly explicitWorkdir: boolean;
  readonly projectRoot: string;
  readonly stack?: string;
  readonly stackId?: string;
}

/** The `supabase status --env ...` pointer `start` prints to reproduce this stack's selection. */
export const statusEnvPointer = (input: StatusEnvPointerInput, platform: ShellPlatform): string => {
  const selector = [
    ...(input.explicitWorkdir ? ["--workdir", input.projectRoot] : []),
    ...(input.stack === undefined ? [] : ["--stack", input.stack]),
    ...(input.stackId === undefined ? [] : ["--stack-id", input.stackId]),
  ]
    .map((argument) => ` ${shellQuoteArgument(argument, platform)}`)
    .join("");
  return `supabase status --env${selector}`;
};
