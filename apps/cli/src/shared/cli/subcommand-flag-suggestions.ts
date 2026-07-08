import type { CliError, Command, HelpDoc } from "effect/unstable/cli";

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

function collectDescendants(
  command: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
): ReadonlyArray<MatchingCommand> {
  const matches: Array<MatchingCommand> = [];
  const visit = (current: Command.Command.Any, path: ReadonlyArray<string>) => {
    for (const group of current.subcommands) {
      for (const child of group.commands) {
        if (child.hidden) continue;

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

// Workaround for a doubled "Expected: Expected ..." prefix in
// effect@4.0.0-beta.93's own primitive parsers. Several `Primitive`s under
// `effect/unstable/cli` (`choice` — used by `Flag.choice`/
// `Flag.choiceWithValue` — plus the schema-backed `integer`, `float`,
// `boolean`, and `date`) fail with a raw message that already starts with
// the word "Expected" (e.g. `Expected "micro" | "small", got "nano"` or
// `Expected a valid date, got Invalid Date`), and `CliError.InvalidValue`'s
// own `message` getter independently prepends its own `"Expected: "` label
// on top of that — so any flag or argument backed by one of these
// primitives renders "Expected: Expected ...". Collapsing the literal
// doubled substring (rather than rebuilding the surrounding "Invalid value
// for ..." template ourselves) keeps this tied to the exact defect and
// covers every affected primitive uniformly, letting every other part of
// the message keep tracking upstream's own wording. Remove once upstream
// `effect` fixes this (see CLI-1898).
const DOUBLED_EXPECTED_PREFIX = "Expected: Expected ";

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

    if (error._tag === "InvalidValue" && error.message.includes(DOUBLED_EXPECTED_PREFIX)) {
      changed = true;
      formatted.push({
        _tag: error._tag,
        message: error.message.replace(DOUBLED_EXPECTED_PREFIX, "Expected "),
        source: error,
        changed: true,
      });
      continue;
    }

    formatted.push({ _tag: error._tag, message: error.message, source: error, changed: false });
  }

  return { errors: formatted, changed };
}
