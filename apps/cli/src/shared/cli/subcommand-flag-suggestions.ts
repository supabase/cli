import { Option, Predicate } from "effect";
import type { CliError, Command, HelpDoc, Param } from "effect/cli";
import { unwrapParam, unwrapToSingleParam } from "../../command-internal/param-introspection.ts";
import { REMOTE_FLAG_NAME } from "../../command-internal/target/remote-vocabulary.ts";
import { isRemoteFlag } from "../../command-internal/target/target-flags.ts";
import { readTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { commandInternals } from "../../docs/docs-introspection.ts";
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

/** `"optional-value"` is a switch when bare and takes a value only through `=` (`--remote`). */
type FlagArity = "switch" | "value" | "optional-value";

interface CommandFlag {
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly arity: FlagArity;
}

interface MatchingCommand {
  readonly command: Command.Command.Any;
  readonly commandPath: ReadonlyArray<string>;
  readonly flag: CommandFlag;
}

function hasHelpDoc(command: Command.Command.Any): command is CommandWithHelpDoc {
  return "buildHelpDoc" in command && typeof command.buildHelpDoc === "function";
}

export function helpDocFor(
  command: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
): HelpDoc.HelpDoc | undefined {
  return hasHelpDoc(command) ? command.buildHelpDoc(commandPath) : undefined;
}

/**
 * The operands a command takes, leaving out a hidden positional: it still parses but is never
 * offered or counted.
 */
export function visibleOperandsOf(
  command: Command.Command.Any,
): ReadonlyArray<{ readonly name: string; readonly variadic: boolean }> {
  return commandInternals(command).config.arguments.flatMap((param) => {
    const unwrapped = unwrapParam(param);
    return unwrapped === undefined || unwrapped.single.hidden
      ? []
      : [{ name: unwrapped.single.name, variadic: unwrapped.isVariadic }];
  });
}

const flagArityOf = (single: Param.Single<Param.ParamKind, unknown>): FlagArity => {
  if (single.primitiveType._tag !== "Boolean") return "value";
  return isRemoteFlag(single) ? "optional-value" : "switch";
};

/** Every flag the command parses, hidden aliases included: parsing consumes their values too. */
function commandFlagsFor(command: Command.Command.Any): ReadonlyArray<CommandFlag> {
  return commandInternals(command).config.flags.flatMap((param) => {
    const single = unwrapToSingleParam(param);
    if (single === undefined) return [];
    return [
      {
        name: single.name,
        aliases: single.aliases.map((alias) => (alias.length === 1 ? `-${alias}` : `--${alias}`)),
        arity: flagArityOf(single),
      },
    ];
  });
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
 * The longest command-path prefix argv's positionals resolve to in the tree: segments descend
 * while they match a subcommand and stop at the first that doesn't (an operand). Includes the
 * root's own name, the shape `isValueTakingFlagTokenFor` expects.
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
        for (const flag of commandFlagsFor(child)) {
          matches.push({ command: child, commandPath: childPath, flag });
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

function flagMatchesOption(flag: CommandFlag, option: string): boolean {
  const optionName = normalizeOption(option);
  if (flag.name === optionName) return true;
  if (flag.arity !== "value" && optionName === `no-${flag.name}`) return true;
  return flag.aliases.includes(option);
}

/**
 * Every argv token (e.g. `-t`, alongside the canonical `--type`) that also resolves to `option`
 * for the command at `commandPath`. Returns `[]` if `commandPath` doesn't resolve to a real
 * command or that command has no flag named `option` — callers should treat that as "no
 * aliases", not an error, since a synthetic/test command path is a legitimate input.
 */
export function flagAliasesFor(
  rootCommand: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
  option: string,
): ReadonlyArray<string> {
  const command = findCommand(rootCommand, commandPath.slice(1));
  if (!command) return [];
  const flag = commandFlagsFor(command).find((candidate) => candidate.name === option);
  return flag?.aliases ?? [];
}

/**
 * Builds a lookup for whether an argv token (a canonical `--name` or an alias) at `commandPath`
 * belongs to a flag that takes the next token as its value, hidden deprecated aliases included
 * and `--remote` excluded (its value comes only through `=`). Answers `false` for every token
 * when `commandPath` doesn't resolve to a real command. Used by `run.ts`'s
 * `isMissingFlagTokenPresent` to detect when the token would have been consumed as a preceding
 * flag's value instead of treating it as its own occurrence.
 */
export function isValueTakingFlagTokenFor(
  rootCommand: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
): (token: string) => boolean {
  const command = findCommand(rootCommand, commandPath.slice(1));
  if (!command) return () => false;
  const valueTakingTokens = new Set<string>();
  for (const flag of commandFlagsFor(command)) {
    if (flag.arity !== "value") continue;
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

function formatFlagUsage(option: string, flag: CommandFlag): string {
  const flagToken = optionToken(option);
  switch (flag.arity) {
    case "switch":
      return flagToken;
    case "optional-value":
      return `${flagToken}[=<value>]`;
    case "value":
      return `${flagToken} <value>`;
  }
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

/** What to say when `--remote` goes to `link` or a local-only command, which take no such flag. */
function remoteFlagMisuseMessage(
  rootCommand: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
): string | undefined {
  const command = findCommand(rootCommand, commandPath.slice(1));
  if (command === undefined) return undefined;
  const usage = `supabase ${commandPath.slice(1).join(" ")}`;
  if (command.name === "link" && commandPath.length === 2) {
    return `${usage} takes the project ref or branch as its argument: ${usage} <ref-or-branch>`;
  }
  return Option.exists(readTargetPolicy(command), (policy) => policy.group === "local-only")
    ? `${usage} is local only; --remote doesn't apply.`
    : undefined;
}

/** Whether `error` is `--remote` given to a command with no such flag and its own message. */
export function isRemoteFlagMisuse(
  error: CliError.CliError,
  rootCommand: Command.Command.Any,
): error is CliError.UnrecognizedOption {
  return (
    Predicate.isTagged(error, "UnrecognizedOption") &&
    normalizeOption(error.option) === REMOTE_FLAG_NAME &&
    error.command !== undefined &&
    remoteFlagMisuseMessage(rootCommand, error.command) !== undefined
  );
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
    attempted && attempted.flag.arity === "value"
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
    if (context && isRemoteFlagMisuse(error, context.rootCommand) && error.command) {
      changed = true;
      formatted.push({
        _tag: error._tag,
        message: remoteFlagMisuseMessage(context.rootCommand, error.command) ?? error.message,
        source: error,
        changed: true,
      });
      continue;
    }

    if (Predicate.isTagged(error, "UnrecognizedOption") && context) {
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

    if (
      Predicate.isTagged(error, "UnknownSubcommand") &&
      suppressedUnknownSubcommands.has(error.subcommand)
    ) {
      changed = true;
      continue;
    }

    if (Predicate.isTagged(error, "InvalidValue")) {
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
