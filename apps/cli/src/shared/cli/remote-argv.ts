import { Result } from "effect";
import type { Command } from "effect/cli";

import { unwrapToSingleParam } from "../../command-internal/param-introspection.ts";
import { parseRemoteValue, type RemoteValue } from "../../command-internal/target/remote-value.ts";
import {
  couldNameBranch,
  DB_URL_PATTERN,
  LINKED_LITERAL,
} from "../../command-internal/target/remote-vocabulary.ts";
import { isRemoteFlag } from "../../command-internal/target/target-flags.ts";
import { commandInternals, userGlobalFlagParams } from "../../docs/docs-introspection.ts";
import { BOOLEAN_FLAG_VALUES } from "./agent-output.ts";
import { visibleOperandsOf } from "./subcommand-flag-suggestions.ts";

export interface RemoteArgvLeaf {
  /** Command-path segments argv names ahead of the leaf's own operands. */
  readonly pathLength: number;
  /** How many operands the leaf takes; `Infinity` when it takes a variable number. */
  readonly operandCapacity: number;
  /** Whether a flag token takes the next argv token as its value. */
  readonly consumesNextToken: (token: string) => boolean;
}

const INLINE_REMOTE_PREFIX = "--remote=";

interface RemoteArgvScan {
  /** Indexes of the bare (non-flag, non-flag-value) tokens ahead of any `--`. */
  readonly bare: ReadonlyArray<number>;
  /** Indexes of the `--remote` tokens that carry no inline value. */
  readonly remotes: ReadonlyArray<number>;
  /** Indexes of the `--remote=<value>` tokens. */
  readonly inline: ReadonlyArray<number>;
  /** Index of the first `--`, or `args.length`. */
  readonly end: number;
}

const scanRemoteArgv = (args: ReadonlyArray<string>, leaf: RemoteArgvLeaf): RemoteArgvScan => {
  const bare: Array<number> = [];
  const remotes: Array<number> = [];
  const inline: Array<number> = [];
  let end = args.length;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      end = index;
      break;
    }
    if (!arg.startsWith("-")) {
      bare.push(index);
      continue;
    }
    if (arg.startsWith(INLINE_REMOTE_PREFIX)) {
      inline.push(index);
      continue;
    }
    const next = args[index + 1];
    const isLiteral = next !== undefined && BOOLEAN_FLAG_VALUES.has(next);
    if (arg === "--remote") {
      if (!isLiteral || LINKED_LITERAL.test(next)) remotes.push(index);
      if (isLiteral) index += 1;
    } else if (leaf.consumesNextToken(arg) || (isLiteral && !arg.includes("="))) {
      index += 1;
    }
  }
  return { bare, remotes, inline, end };
};

/**
 * Joins a bare `--remote <word>` into `--remote=<word>` when the word cannot be one of the
 * command's operands: the command takes none, the word is a database URL or a boolean literal, or
 * the command already has more operands than it takes.
 */
export function joinRemoteOperands(
  args: ReadonlyArray<string>,
  leaf: RemoteArgvLeaf,
): ReadonlyArray<string> {
  const { bare, remotes, end } = scanRemoteArgv(args, leaf);

  const operandCount =
    bare.length - leaf.pathLength + (end < args.length ? args.length - end - 1 : 0);
  const joined = new Set<number>();
  for (const index of remotes) {
    const word = args[index + 1];
    if (word === undefined || word.startsWith("-")) continue;
    const ordinal = bare.indexOf(index + 1);
    if (ordinal !== -1 && ordinal < leaf.pathLength) continue;
    if (
      LINKED_LITERAL.test(word) ||
      leaf.operandCapacity === 0 ||
      DB_URL_PATTERN.test(word) ||
      (couldNameBranch(word) && operandCount > leaf.operandCapacity)
    ) {
      joined.add(index);
    }
  }
  if (joined.size === 0) return args;
  return args.flatMap((arg, index) => {
    if (joined.has(index)) return [`--remote=${args[index + 1]}`];
    return joined.has(index - 1) ? [] : [arg];
  });
}

const selectionKey = (value: RemoteValue): string => {
  switch (value._tag) {
    case "Linked":
      return "linked";
    case "Ref":
      return `ref:${value.ref}`;
    case "DbUrl":
      return `db-url:${value.url}`;
    case "Branch":
      return `branch:${value.name}`;
  }
};

/**
 * Whether `args`, with bare `--remote <word>` already joined, give `--remote` more than once with
 * values that differ. A bare `--remote` selects the linked project, even when an operand follows
 * it; a value the flag rejects is left for its parser to report.
 */
export function hasConflictingRemotes(args: ReadonlyArray<string>, leaf: RemoteArgvLeaf): boolean {
  const { remotes, inline } = scanRemoteArgv(args, leaf);
  const selections = new Set<string>();
  if (remotes.length > 0) selections.add(selectionKey({ _tag: "Linked" }));
  for (const index of inline) {
    const parsed = parseRemoteValue((args[index] ?? "").slice(INLINE_REMOTE_PREFIX.length));
    if (Result.isSuccess(parsed)) selections.add(selectionKey(parsed.success));
  }
  return selections.size > 1;
}

const UNKNOWN_LEAF: RemoteArgvLeaf = {
  pathLength: 0,
  operandCapacity: Infinity,
  consumesNextToken: () => false,
};

/**
 * The word a bare `--remote` is directly followed by when the command took it as an operand and
 * it could name a branch, so it may be meant as `--remote=<word>`. Without a `leaf` no word is
 * known to be a command-path segment.
 */
export function bareRemoteOperand(
  args: ReadonlyArray<string>,
  leaf: RemoteArgvLeaf = UNKNOWN_LEAF,
): string | undefined {
  const { bare, remotes } = scanRemoteArgv(args, leaf);
  for (const index of remotes) {
    const word = args[index + 1];
    if (word === undefined || word.startsWith("-")) continue;
    const ordinal = bare.indexOf(index + 1);
    if (ordinal === -1 || ordinal < leaf.pathLength) continue;
    if (couldNameBranch(word)) return word;
  }
  return undefined;
}

const declaresRemoteFlag = (command: Command.Command.Any): boolean =>
  [...commandInternals(command).config.flags, ...userGlobalFlagParams(command)].some((param) => {
    const single = unwrapToSingleParam(param);
    return single !== undefined && isRemoteFlag(single);
  });

/**
 * The operand capacity of the command `path` resolves to (a hidden positional counts for nothing),
 * or `undefined` when it does not accept `--remote` (as its own flag, or as a persistent flag of an
 * ancestor such as `seed`).
 */
export function remoteOperandCapacity(
  rootCommand: Command.Command.Any,
  path: ReadonlyArray<string>,
): number | undefined {
  const commands: Array<Command.Command.Any> = [rootCommand];
  for (const segment of path.slice(1)) {
    const parent = commands[commands.length - 1];
    const next = parent?.subcommands
      .flatMap((group) => group.commands)
      .find((command) => command.name === segment || command.alias === segment);
    if (next === undefined) return undefined;
    commands.push(next);
  }
  const leaf = commands[commands.length - 1];
  if (leaf === undefined) return undefined;
  if (!commands.some(declaresRemoteFlag)) return undefined;
  const operands = visibleOperandsOf(leaf);
  return operands.some((operand) => operand.variadic) ? Infinity : operands.length;
}
