const functionSlugPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const invalidFunctionSlugDetail =
  "Invalid Function name. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (^[A-Za-z][A-Za-z0-9_-]*$)";

export function validateFunctionSlugMessage(slug: string): string | undefined {
  return functionSlugPattern.test(slug) ? undefined : invalidFunctionSlugDetail;
}

/**
 * Detects whether `flagName` was explicitly passed by the user, reproducing
 * cobra's `pflag.Changed` for the Go CLI's `MarkFlagsMutuallyExclusive`.
 * Scans raw argv rather than the parsed flag value so a `Flag.withDefault`
 * value isn't mistaken for explicit user input.
 */
export function hasExplicitLongFlag(
  rawArgs: ReadonlyArray<string>,
  commandPath: ReadonlyArray<string>,
  flagName: string,
): boolean {
  const commandIndex = rawArgs.findIndex((_, index) =>
    commandPath.every((segment, offset) => rawArgs[index + offset] === segment),
  );
  if (commandIndex === -1) {
    return rawArgs.some((token) => token === `--${flagName}` || token.startsWith(`--${flagName}=`));
  }

  for (let index = commandIndex + commandPath.length; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === undefined || token === "--") {
      return false;
    }
    if (token === `--${flagName}` || token.startsWith(`--${flagName}=`)) {
      return true;
    }
  }
  return false;
}
