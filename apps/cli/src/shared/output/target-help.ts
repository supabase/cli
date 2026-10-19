import { Array as Arr, Context, Option } from "effect";
import type { Command, HelpDoc } from "effect/cli";
import { REMOTE_FLAG_NAME } from "../../command-internal/target/remote-vocabulary.ts";
import { TargetPolicyAnnotation } from "../../command-internal/target/target-policy.ts";

type TargetKind = "selectable" | "hosted" | "local-only";

interface TargetCopy {
  readonly scope: string;
  readonly summary: string;
  /** The value `--remote` accepts on this kind of command; `undefined` when it takes none. */
  readonly remoteValue: string | undefined;
}

const TARGET_COPY: Readonly<Record<TargetKind, TargetCopy>> = {
  selectable: {
    scope: "local or remote",
    summary:
      "Local by default. Pass --remote for the linked project, or --remote=<ref|branch|url>.",
    remoteValue: "<ref|branch|url>",
  },
  hosted: {
    scope: "remote only",
    summary: "Remote only. Uses the linked project; pass --remote=<ref|branch> for another.",
    remoteValue: "<ref|branch>",
  },
  "local-only": {
    scope: "local only",
    summary: "Local only. Runs against the local stack.",
    remoteValue: undefined,
  },
};

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

const kindOf = (annotations: Context.Context<never>): TargetKind | undefined =>
  Context.getOption(annotations, TargetPolicyAnnotation).pipe(
    Option.flatMapNullishOr((policy) => KIND_BY_GROUP[policy.group]),
    Option.getOrUndefined,
  );

const declaresRemoteFlag = (doc: HelpDoc.HelpDoc): boolean =>
  [...doc.flags, ...(doc.globalFlags ?? [])].some((flag) => flag.name === REMOTE_FLAG_NAME);

/** What a leaf's help says about its target; `undefined` for account, removed and group commands. */
export function targetHelpFor(doc: HelpDoc.HelpDoc): TargetHelp | undefined {
  const kind = kindOf(doc.annotations);
  if (kind === undefined) return undefined;
  const { scope, summary } = TARGET_COPY[kind];
  return {
    scope,
    summary: declaresRemoteFlag(doc) ? summary : summary.slice(0, summary.indexOf(".") + 1),
  };
}

/** The value hint `--remote` takes on a command, e.g. `<ref|branch>`; `undefined` where it takes none. */
export function remoteValueHint(annotations: Context.Context<never>): string | undefined {
  const kind = kindOf(annotations);
  return kind === undefined ? undefined : TARGET_COPY[kind].remoteValue;
}

/** The `--remote` flag rows show the value `remote` takes on this command: `--remote[=<ref|branch>]`. */
export function withRemoteFlagUsage(doc: HelpDoc.HelpDoc): HelpDoc.HelpDoc {
  const hint = remoteValueHint(doc.annotations);
  if (hint === undefined || !declaresRemoteFlag(doc)) return doc;
  const rename = (flag: HelpDoc.FlagDoc): HelpDoc.FlagDoc =>
    flag.name === REMOTE_FLAG_NAME ? { ...flag, name: remoteFlagName(hint) } : flag;
  return {
    ...doc,
    flags: doc.flags.map(rename),
    ...(doc.globalFlags === undefined ? {} : { globalFlags: doc.globalFlags.map(rename) }),
  };
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
    const kind = kindOf(child.annotations);
    if (kind !== undefined) scopes.set(child.name, TARGET_COPY[kind].scope);
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
