import { Array as Arr, Context, Option } from "effect";
import type { Command, HelpDoc } from "effect/cli";
import { REMOTE_FLAG_NAME } from "../../command-internal/target/remote-vocabulary.ts";
import { TargetPolicyAnnotation } from "../../command-internal/target/target-policy.ts";

type TargetKind = "selectable" | "hosted" | "local-only";

export interface TargetCopy {
  readonly scope: string;
  /** The TARGET summary, given the value hint of the command's `--remote` flag. */
  readonly summary: (hint: string) => string;
  /** The `--remote` flag's description, given its value hint, when the flag's own does not fit. */
  readonly remoteDescription?: (hint: string) => string;
}

const TARGET_COPY: Readonly<Record<TargetKind, TargetCopy>> = {
  selectable: {
    scope: "local or remote",
    summary: (hint) =>
      `Local by default. Pass --remote for the linked project, or --remote=${hint}.`,
  },
  hosted: {
    scope: "remote only",
    summary: (hint) => `Remote only. Uses the linked project; pass --remote=${hint} for another.`,
  },
  "local-only": {
    scope: "local only",
    summary: () => "Local only. Runs against the local stack.",
  },
};

/**
 * A leaf whose default target is neither the local stack nor the linked project declares its own
 * TARGET copy, which replaces its policy group's.
 */
export class TargetHelpAnnotation extends Context.Service<TargetHelpAnnotation, TargetCopy>()(
  "supabase/TargetHelpAnnotation",
) {}

const KIND_BY_GROUP: Readonly<Record<string, TargetKind | undefined>> = {
  selectable: "selectable",
  hosted: "hosted",
  "local-only": "local-only",
};

/** The flag's display name once its value hint is known: `remote[=<ref|branch>]`. */
export const remoteFlagName = (hint: string): string => `${REMOTE_FLAG_NAME}[=${hint}]`;

export interface TargetHelp {
  readonly scope: string;
  readonly summary: string;
}

const copyOf = (annotations: Context.Context<never>): TargetCopy | undefined =>
  Option.getOrUndefined(Context.getOption(annotations, TargetHelpAnnotation)) ??
  Context.getOption(annotations, TargetPolicyAnnotation).pipe(
    Option.flatMapNullishOr((policy) => KIND_BY_GROUP[policy.group]),
    Option.map((kind) => TARGET_COPY[kind]),
    Option.getOrUndefined,
  );

const remoteFlagOf = (doc: HelpDoc.HelpDoc): HelpDoc.FlagDoc | undefined =>
  [...doc.flags, ...(doc.globalFlags ?? [])].find((flag) => flag.name === REMOTE_FLAG_NAME);

/** What a leaf's help says of its target; `undefined` for account, removed and group commands. */
export function targetHelpFor(doc: HelpDoc.HelpDoc): TargetHelp | undefined {
  const copy = copyOf(doc.annotations);
  if (copy === undefined) return undefined;
  const { scope, summary } = copy;
  const flag = remoteFlagOf(doc);
  const full = summary(flag?.type ?? "");
  return { scope, summary: flag === undefined ? full.slice(0, full.indexOf(".") + 1) : full };
}

const mapRemoteFlag = (
  doc: HelpDoc.HelpDoc,
  transform: (flag: HelpDoc.FlagDoc) => HelpDoc.FlagDoc,
): HelpDoc.HelpDoc => {
  const describe = Option.getOrUndefined(
    Context.getOption(doc.annotations, TargetHelpAnnotation),
  )?.remoteDescription;
  const apply = (flag: HelpDoc.FlagDoc) =>
    flag.name !== REMOTE_FLAG_NAME
      ? flag
      : transform(
          describe === undefined
            ? flag
            : { ...flag, description: Option.some(describe(flag.type)) },
        );
  return {
    ...doc,
    flags: doc.flags.map(apply),
    ...(doc.globalFlags === undefined ? {} : { globalFlags: doc.globalFlags.map(apply) }),
  };
};

/** Text help shows the `--remote` row as `--remote[=<hint>]`, with no separate type column. */
export function withRemoteFlagUsage(doc: HelpDoc.HelpDoc): HelpDoc.HelpDoc {
  return mapRemoteFlag(doc, (flag) => ({
    ...flag,
    name: remoteFlagName(flag.type),
    type: "boolean",
  }));
}

/** JSON help keeps the flag's name and says it takes an optional value: `value` is its hint. */
export function withRemoteFlagValue(doc: HelpDoc.HelpDoc): HelpDoc.HelpDoc {
  return mapRemoteFlag(doc, (flag) => ({
    ...flag,
    type: "string",
    value: flag.type,
    valueOptional: true,
  }));
}

function findCommand(
  root: Command.Command.Any,
  path: ReadonlyArray<string>,
): Command.Command.Any | undefined {
  let current = root;
  for (const segment of path) {
    const next = current.subcommands
      .flatMap((group) => group.commands)
      .find((command) => command.name === segment || command.alias === segment);
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

/** The command a help doc describes: its usage line starts with the command path, root first. */
function commandForDoc(
  root: Command.Command.Any,
  doc: HelpDoc.HelpDoc,
): Command.Command.Any | undefined {
  const path: Array<string> = [];
  for (const token of doc.usage.split(" ")) {
    if (token.startsWith("<") || token.startsWith("[")) break;
    path.push(token);
  }
  return findCommand(root, path.slice(1));
}

/** Scope label per subcommand row of a group's help, keyed by subcommand name. */
export function subcommandScopes(
  doc: HelpDoc.HelpDoc,
  root: Command.Command.Any | undefined,
): ReadonlyMap<string, string> {
  const scopes = new Map<string, string>();
  if (root === undefined || doc.subcommands === undefined) return scopes;
  const parent = commandForDoc(root, doc);
  if (parent === undefined) return scopes;
  for (const child of parent.subcommands.flatMap((group) => group.commands)) {
    const copy = copyOf(child.annotations);
    if (copy !== undefined) scopes.set(child.name, copy.scope);
  }
  return scopes;
}

/** The doc with each labelled subcommand row suffixed `  [local or remote]`. */
export function labelSubcommands(
  doc: HelpDoc.HelpDoc,
  root: Command.Command.Any | undefined,
): HelpDoc.HelpDoc {
  const scopes = subcommandScopes(doc, root);
  if (doc.subcommands === undefined || scopes.size === 0) return doc;
  return {
    ...doc,
    subcommands: doc.subcommands.map((group) => ({
      ...group,
      commands: Arr.map(group.commands, (sub) => {
        const scope = scopes.get(sub.name);
        return scope === undefined
          ? sub
          : { ...sub, shortDescription: `${sub.shortDescription ?? sub.description}  [${scope}]` };
      }),
    })),
  };
}
