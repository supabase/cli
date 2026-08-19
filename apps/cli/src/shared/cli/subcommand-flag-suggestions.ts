import type { CliError, Command, HelpDoc } from "effect/unstable/cli";
import { formatInvalidValueMessage } from "./invalid-value-message.ts";

export interface CliErrorSuggestionContext {
  readonly rootCommand: Command.Command.Any;
  readonly args: ReadonlyArray<string>;
}

export interface FormattedCliError {
  readonly _tag: string;
  readonly message: string;
  readonly source: CliError.CliError;
  readonly changed: boolean;
}

export interface FormattedCliErrors {
  readonly errors: ReadonlyArray<FormattedCliError>;
  readonly changed: boolean;
}

export function cliErrorCode(error: CliError.CliError): string {
  return error._tag;
}

interface CommandWithHelpDoc extends Command.Command.Any {
  readonly buildHelpDoc: (path: ReadonlyArray<string>) => HelpDoc.HelpDoc;
}

interface MatchingCommand {
  readonly command: Command.Command.Any;
  readonly commandPath: ReadonlyArray<string>;
  readonly flag: HelpDoc.FlagDoc;
}

function hasHelpDoc(command: Command.Command.Any): command is CommandWithHelpDoc {
  return "buildHelpDoc" in command && typeof command.buildHelpDoc === "function";
}

function helpDocFor(
  command: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
): HelpDoc.HelpDoc | undefined {
  return hasHelpDoc(command) ? command.buildHelpDoc(commandPath) : undefined;
}

function findCommand(
  root: Command.Command.Any,
  pathWithoutRoot: ReadonlyArray<string>,
): Command.Command.Any | undefined {
  let current = root;
  for (const segment of pathWithoutRoot) {
    let next: Command.Command.Any | undefined;
    for (const group of current.subcommands) {
      next = group.commands.find(
        (command) => command.name === segment || command.alias === segment,
      );
      if (next) break;
    }
    if (!next) return undefined;
    current = next;
  }
  return current;
}

/**
 * The longest command-path prefix argv's positionals resolve to in the tree,
 * cobra-`Find`-style: segments descend while they match a subcommand and stop
 * at the first that doesn't (an operand). Includes the root's own name, the
 * shape `isValueTakingFlagTokenFor` expects.
 */
export function resolvedCommandPathForArgv(
  rootCommand: Command.Command.Any,
  positionals: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const path: Array<string> = [rootCommand.name];
  let current: Command.Command.Any = rootCommand;
  for (const segment of positionals) {
    let next: Command.Command.Any | undefined;
    for (const group of current.subcommands) {
      next = group.commands.find(
        (command) => command.name === segment || command.alias === segment,
      );
      if (next) break;
    }
    if (!next) break;
    current = next;
    path.push(segment);
  }
  return path;
}

function collectDescendants(
  command: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
): ReadonlyArray<MatchingCommand> {
  const matches: Array<MatchingCommand> = [];
  const visit = (current: Command.Command.Any, path: ReadonlyArray<string>) => {
    for (const group of current.subcommands) {
      for (const child of group.commands) {
        if (child.unlisted) continue;

        const childPath = [...path, child.name];
        const helpDoc = helpDocFor(child, childPath);
        if (helpDoc) {
          for (const flag of helpDoc.flags) {
            matches.push({ command: child, commandPath: childPath, flag });
          }
        }
        visit(child, childPath);
      }
    }
  };
  visit(command, commandPath);
  return matches;
}

function optionToken(option: string): string {
  const withoutValue = option.split("=", 1)[0] ?? option;
  return withoutValue;
}

function normalizeOption(option: string): string {
  const withoutValue = optionToken(option);
  if (withoutValue.startsWith("--")) return withoutValue.slice(2);
  if (withoutValue.startsWith("-")) return withoutValue.slice(1);
  return withoutValue;
}

function flagMatchesOption(flag: HelpDoc.FlagDoc, option: string): boolean {
  const optionName = normalizeOption(option);
  if (flag.name === optionName) return true;
  if (flag.type === "boolean" && optionName === `no-${flag.name}`) return true;
  return flag.aliases.includes(option);
}

/**
 * Every argv token (e.g. `-t`, alongside the canonical `--type`) that also
 * resolves to `option` for the command at `commandPath`, by walking the
 * command tree the same way `buildSubcommandFlagHint` does. Returns `[]` if
 * `commandPath` doesn't resolve to a real command or that command has no
 * flag named `option` — callers should treat that as "no aliases", not an
 * error, since a synthetic/test command path is a legitimate input.
 *
 * Used by `run.ts`'s `isMissingFlagTokenPresent` to recognize a required
 * flag supplied by its short alias but missing its value (Go/pflag still
 * shows usage for that case — see CLI-1901) instead of misclassifying it as
 * genuinely absent (Go: `SilenceUsage`-suppressed, no usage shown).
 */
export function flagAliasesFor(
  rootCommand: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
  option: string,
): ReadonlyArray<string> {
  const command = findCommand(rootCommand, commandPath.slice(1));
  if (!command) return [];
  const flag = helpDocFor(command, commandPath)?.flags.find(
    (candidate) => candidate.name === option,
  );
  return flag?.aliases ?? [];
}

/**
 * Builds a lookup for whether an argv token (a canonical `--name` or one of
 * its aliases, e.g. `-t`) at `commandPath` belongs to a *value-taking* flag
 * (any flag whose `HelpDoc.FlagDoc.type !== "boolean"`) on the command
 * resolved the same way `flagAliasesFor` does. Returns a function that
 * answers `false` for every token when `commandPath` doesn't resolve to a
 * real command, mirroring `flagAliasesFor`'s "no aliases" fallback.
 *
 * Used by `run.ts`'s `isMissingFlagTokenPresent` to recognize when a
 * DIFFERENT flag's value-consumption ate the very token being scanned for.
 * Go/pflag's `parseLongArg` (`flag.go`) unconditionally consumes the next
 * argv entry as a value-taking flag's value, even when that entry itself
 * looks like another flag — e.g. `sso add --project-ref --type` hands the
 * literal string `--type` to `--project-ref`, so `--type` is never seen as
 * its own occurrence and its `MissingOption` failure gets Go's
 * `SilenceUsage` treatment (no usage shown). The vendored `effect` CLI
 * library's own parser does NOT replicate that (`internal/parser.ts`'s
 * `consumeFlagValueWithTokens` only consumes a following token when it's
 * lexed as a plain `Value`, never a flag-shaped token), so without this
 * lookup the raw argv scan in `isMissingFlagTokenPresent` would find the
 * literal `--type` token and wrongly conclude the flag is present but
 * missing its value — reintroducing the usage dump CLI-1901 suppresses.
 */
export function isValueTakingFlagTokenFor(
  rootCommand: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
): (token: string) => boolean {
  const command = findCommand(rootCommand, commandPath.slice(1));
  const flags = command && helpDocFor(command, commandPath)?.flags;
  if (!flags) return () => false;
  const valueTakingTokens = new Set<string>();
  for (const flag of flags) {
    if (flag.type === "boolean") continue;
    valueTakingTokens.add(`--${flag.name}`);
    for (const alias of flag.aliases) valueTakingTokens.add(alias);
  }
  return (token: string) => valueTakingTokens.has(token);
}

function findPathEndIndex(
  args: ReadonlyArray<string>,
  pathWithoutRoot: ReadonlyArray<string>,
): number | undefined {
  if (pathWithoutRoot.length === 0) return 0;
  for (let start = 0; start <= args.length - pathWithoutRoot.length; start++) {
    let matches = true;
    for (let offset = 0; offset < pathWithoutRoot.length; offset++) {
      if (args[start + offset] !== pathWithoutRoot[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return start + pathWithoutRoot.length;
  }
  return undefined;
}

function inferAttemptedCommand(
  args: ReadonlyArray<string>,
  currentPath: ReadonlyArray<string>,
  matches: ReadonlyArray<MatchingCommand>,
): MatchingCommand | undefined {
  const pathEnd = findPathEndIndex(args, currentPath.slice(1));
  const searchArgs = pathEnd === undefined ? args : args.slice(pathEnd);
  for (const arg of searchArgs) {
    if (arg.startsWith("-")) continue;
    const match = matches.find((candidate) => {
      const leaf = candidate.commandPath[candidate.commandPath.length - 1];
      return leaf === arg || candidate.command.alias === arg;
    });
    if (match) return match;
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function formatCommandList(matches: ReadonlyArray<MatchingCommand>): string {
  const commands = [...new Set(matches.map((match) => `\`${match.commandPath.join(" ")}\``))];
  if (commands.length === 1) return commands[0] ?? "";
  if (commands.length === 2) return `${commands[0]} and ${commands[1]}`;
  return `${commands.slice(0, -1).join(", ")}, and ${commands[commands.length - 1]}`;
}

function formatFlagUsage(option: string, flag: HelpDoc.FlagDoc): string {
  const flagToken = optionToken(option);
  return flag.type === "boolean" ? flagToken : `${flagToken} <value>`;
}

function findValueAfterOption(args: ReadonlyArray<string>, option: string): string | undefined {
  const flagToken = optionToken(option);
  if (option !== flagToken) return undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === flagToken) {
      const next = args[index + 1];
      return next && !next.startsWith("-") ? next : undefined;
    }
    if (arg.startsWith(`${flagToken}=`)) return undefined;
  }
  return undefined;
}

function buildSubcommandFlagHint(
  error: CliError.UnrecognizedOption,
  context: CliErrorSuggestionContext,
): { readonly hint: string; readonly consumedValue?: string } | undefined {
  if (!error.command || error.command.length === 0) return undefined;

  const current = findCommand(context.rootCommand, error.command.slice(1));
  if (!current || current.subcommands.length === 0) return undefined;

  const matches = collectDescendants(current, error.command).filter((match) =>
    flagMatchesOption(match.flag, error.option),
  );
  if (matches.length === 0) return undefined;

  const attempted = inferAttemptedCommand(context.args, error.command, matches);
  const flagToken = optionToken(error.option);
  const availableOn =
    matches.length === 1
      ? `a flag for ${formatCommandList(matches)}`
      : `available on ${formatCommandList(matches)}`;
  const example = attempted
    ? `, for example:\n    ${attempted.commandPath.join(" ")} ${formatFlagUsage(error.option, attempted.flag)}`
    : ".";
  const consumedValue =
    attempted && attempted.flag.type !== "boolean"
      ? findValueAfterOption(context.args, error.option)
      : undefined;

  return {
    hint: `${flagToken} is ${availableOn}. Pass it after the subcommand${example}`,
    ...(consumedValue ? { consumedValue } : {}),
  };
}

export function formatCliErrorsForDisplay(
  errors: ReadonlyArray<CliError.CliError>,
  context?: CliErrorSuggestionContext,
): FormattedCliErrors {
  const suppressedUnknownSubcommands = new Set<string>();
  const formatted: Array<FormattedCliError> = [];
  let changed = false;

  for (const error of errors) {
    if (error._tag === "UnrecognizedOption" && context) {
      const hint = buildSubcommandFlagHint(error, context);
      if (hint) {
        if (hint.consumedValue) suppressedUnknownSubcommands.add(hint.consumedValue);
        changed = true;
        formatted.push({
          _tag: error._tag,
          message: `${error.message}\n\n  Hint: ${hint.hint}`,
          source: error,
          changed: true,
        });
        continue;
      }
    }

    if (error._tag === "UnknownSubcommand" && suppressedUnknownSubcommands.has(error.subcommand)) {
      changed = true;
      continue;
    }

    if (error._tag === "InvalidValue") {
      const message = formatInvalidValueMessage(error);
      if (message !== undefined) {
        changed = true;
        formatted.push({
          _tag: error._tag,
          message,
          source: error,
          changed: true,
        });
        continue;
      }
    }

    formatted.push({
      _tag: cliErrorCode(error),
      message: error.message,
      source: error,
      changed: false,
    });
  }

  return { errors: formatted, changed };
}
