import {
  shellQuoteArgument,
  type ShellPlatform,
} from "../../../../command-internal/shell-quote.ts";

export interface StatusEnvPointerInput {
  readonly explicitWorkdir: boolean;
  readonly projectRoot: string;
  readonly stack?: string;
}

/** The `supabase status --env ...` pointer `start` prints to reproduce this stack's selection. */
export const statusEnvPointer = (input: StatusEnvPointerInput, platform: ShellPlatform): string => {
  const selector = [
    ...(input.explicitWorkdir ? ["--workdir", input.projectRoot] : []),
    /* A value starting with `-` is joined with `=` so the parser does not read it as a flag. */
    ...(input.stack === undefined
      ? []
      : input.stack.startsWith("-")
        ? [`--stack=${input.stack}`]
        : ["--stack", input.stack]),
  ]
    .map((argument) => ` ${shellQuoteArgument(argument, platform)}`)
    .join("");
  return `supabase status --env${selector}`;
};
