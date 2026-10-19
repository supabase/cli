import type { Command } from "effect/cli";

import { BRANCH_PROJECT_REF_PATTERN } from "../../command-internal/ref-patterns.ts";
import { couldNameBranch } from "../../command-internal/target/remote-value.ts";
import { commandInternals } from "../../docs/docs-introspection.ts";
import { BOOLEAN_FLAG_VALUES } from "./agent-output.ts";
import { helpDocFor } from "./subcommand-flag-suggestions.ts";

export interface RemoteArgvLeaf {
  /** Command-path segments argv names ahead of the leaf's own operands. */
  readonly pathLength: number;
  /** How many operands the leaf takes; `Infinity` when it takes a variable number. */
  readonly operandCapacity: number;
  /** Whether a flag token takes the next argv token as its value. */
  readonly consumesNextToken: (token: string) => boolean;
}

const LINKED_LITERALS: ReadonlySet<string> = new Set(["true", "yes", "on", "1"]);
const DB_URL_PATTERN = /^postgres(ql)?:\/\//;

/**
 * Joins a bare `--remote <word>` into `--remote=<word>` when the word cannot be one of the
 * command's operands: the command takes none, the word is a project ref, a database URL or a
 * boolean literal, or the command already has more operands than it takes.
 */
export function joinRemoteOperands(
  args: ReadonlyArray<string>,
  leaf: RemoteArgvLeaf,
): ReadonlyArray<string> {
  const bare: Array<number> = [];
  const remotes: Array<number> = [];
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
    const next = args[index + 1];
    const isLiteral = next !== undefined && BOOLEAN_FLAG_VALUES.has(next);
    if (arg === "--remote") {
      if (!isLiteral || LINKED_LITERALS.has(next)) remotes.push(index);
      if (isLiteral) index += 1;
    } else if (leaf.consumesNextToken(arg) || (isLiteral && !arg.includes("="))) {
      index += 1;
    }
  }

  const operandCount =
    bare.length - leaf.pathLength + (end < args.length ? args.length - end - 1 : 0);
  const joined = new Set<number>();
  for (const index of remotes) {
    const word = args[index + 1];
    if (word === undefined || word.startsWith("-")) continue;
    const ordinal = bare.indexOf(index + 1);
    if (ordinal !== -1 && ordinal < leaf.pathLength) continue;
    if (
      LINKED_LITERALS.has(word) ||
      leaf.operandCapacity === 0 ||
      BRANCH_PROJECT_REF_PATTERN.test(word) ||
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

/**
 * The operand capacity of the command `path` resolves to, or `undefined` when it does not accept
 * `--remote` (as its own flag, or as a persistent flag of an ancestor such as `seed`).
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
  const doc = helpDocFor(leaf, path);
  const acceptsRemote =
    doc?.flags.some((flag) => flag.name === "remote") === true ||
    commands.some((command) =>
      commandInternals(command).globalFlags.some(
        (flag) => flag._tag === "Setting" && flag.id === "remote",
      ),
    );
  if (!acceptsRemote) return undefined;
  const operands = doc?.args ?? [];
  return operands.some((operand) => operand.variadic) ? Infinity : operands.length;
}
