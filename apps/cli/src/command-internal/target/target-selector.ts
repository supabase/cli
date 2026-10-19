import { Option, Result } from "effect";

import { parseNamedRemote, type RemoteValue } from "./remote-value.ts";
import type { TargetFlagValues } from "./target-flags.ts";
import {
  TargetEmptyValueError,
  TargetInvalidValueError,
  TargetNeedsProjectError,
  TargetProjectRefConflictError,
  TargetSelectorConflictError,
  type TargetSelectorError,
} from "./target.errors.ts";

/** The decoded selector flags; `dbUrl` is absent for a command with no database connection, which rejects a database URL. */
export type TargetSelectorInput = TargetFlagValues & {
  readonly dbUrl?: Option.Option<string> | undefined;
};

/** What the flags select: the default, the local stack, or a remote project, branch or database. */
type TargetSelection = { readonly _tag: "Default" } | { readonly _tag: "Local" } | RemoteValue;

/** Whether any selector flag, `--local` and the deprecated aliases included, was given. */
export const hasExplicitSelector = (flags: TargetSelectorInput): boolean =>
  flags.local ||
  flags.linked ||
  Option.isSome(flags.remote) ||
  Option.isSome(flags.projectRef) ||
  Option.isSome(flags.projectId ?? Option.none()) ||
  Option.isSome(flags.dbUrl ?? Option.none());

type RemoteAliasFlag = "--linked" | "--project-ref" | "--project-id" | "--db-url";

/** A deprecated selector flag the run used, with the `--remote` form it maps to. */
export type TargetDeprecation =
  | {
      readonly kind: "remote-alias";
      readonly flags: ReadonlyArray<RemoteAliasFlag>;
      readonly remote: RemoteValue;
    }
  | { readonly kind: "local" };

export interface ParsedTargetSelector {
  readonly selection: TargetSelection;
  readonly deprecations: ReadonlyArray<TargetDeprecation>;
}

export interface TargetSelectorOptions {
  /** Names the command in the error for a database URL it cannot use. */
  readonly commandName?: string;
  /** What `--remote` takes on this command, for the suggestions; a command with no `dbUrl` input defaults to `<ref|branch>`. */
  readonly valueHint?: string;
}

/** Lists flag names as `a`, `a and b` or `a, b and c`. */
export const joinFlags = (flags: ReadonlyArray<string>): string =>
  flags.length <= 2
    ? flags.join(" and ")
    : `${flags.slice(0, -1).join(", ")} and ${flags[flags.length - 1]}`;

const emptyValueError = (flag: "--db-url" | "--project-ref" | "--project-id") =>
  new TargetEmptyValueError({
    flag,
    message: `${flag} cannot be empty.`,
    suggestion:
      flag === "--db-url"
        ? "Pass a connection string as --remote=<db-url>."
        : "Pass a project ref, for example --remote=abcdefghijklmnopqrst",
  });

const PROJECT_REF_CONFLICT_SUGGESTION: Readonly<
  Record<"--remote" | "--local" | "--db-url", string>
> = {
  "--remote": "Use --remote=<ref> alone.",
  "--local": "Use --remote=<ref> for the project, or leave both out for the local database.",
  "--db-url": "Use --remote=<ref> for the project or --remote=<url> for the database, not both.",
};

const trimmed = (value: string): string => value.trim();

/**
 * A `false` switch counts as absent, so `--linked=false` and `--no-linked` select nothing.
 * `--linked`, `--project-ref`, `--project-id` and `--db-url` resolve exactly like the `--remote`
 * form they map to and are reported as deprecations; `--local` selects the default.
 */
export const parseTargetSelector = (
  input: TargetSelectorInput,
  options: TargetSelectorOptions = {},
): Result.Result<ParsedTargetSelector, TargetSelectorError> => {
  const remote = Option.getOrUndefined(input.remote);
  const dbUrl = Option.getOrUndefined(Option.map(input.dbUrl ?? Option.none(), trimmed));
  const projectRef = Option.getOrUndefined(Option.map(input.projectRef, trimmed));
  const projectId = Option.getOrUndefined(Option.map(input.projectId ?? Option.none(), trimmed));
  const valueHint =
    options.valueHint ?? (input.dbUrl === undefined ? "<ref|branch>" : "<ref|branch|url>");

  if (dbUrl === "") return Result.fail(emptyValueError("--db-url"));
  if (projectRef === "") return Result.fail(emptyValueError("--project-ref"));
  if (projectId === "") return Result.fail(emptyValueError("--project-id"));

  const selected = [
    ...(remote === undefined ? [] : ["--remote"]),
    ...(input.linked ? ["--linked"] : []),
    ...(dbUrl === undefined ? [] : ["--db-url"]),
    ...(input.local ? ["--local"] : []),
  ];
  const available =
    input.dbUrl === undefined
      ? ["--remote", "--linked", "--local"]
      : ["--remote", "--linked", "--db-url", "--local"];
  if (selected.length > 1) {
    return Result.fail(
      new TargetSelectorConflictError({
        flags: selected,
        message: `Only one of ${joinFlags(available)} can be set; got ${joinFlags(selected)}.`,
        suggestion: `Use --remote or --remote=${valueHint} on its own.`,
      }),
    );
  }

  if (projectRef !== undefined && projectId !== undefined) {
    return Result.fail(
      new TargetSelectorConflictError({
        flags: ["--project-id", "--project-ref"],
        message: "--project-id is a deprecated alias of --project-ref; pass only one of them.",
        suggestion: "Use --remote=<ref> instead.",
      }),
    );
  }
  const aliasFlag = projectRef === undefined ? "--project-id" : "--project-ref";
  const aliasValue = projectRef ?? projectId;
  if (aliasValue !== undefined) {
    const conflictsWith = input.local
      ? "--local"
      : dbUrl !== undefined
        ? "--db-url"
        : remote !== undefined && remote._tag !== "Linked"
          ? "--remote"
          : undefined;
    if (conflictsWith !== undefined) {
      return Result.fail(
        new TargetProjectRefConflictError({
          conflictsWith,
          message:
            conflictsWith === "--remote"
              ? `${aliasFlag} cannot be combined with --remote=<value>.`
              : `${aliasFlag} selects a remote project and cannot be combined with ${conflictsWith}.`,
          suggestion: PROJECT_REF_CONFLICT_SUGGESTION[conflictsWith],
        }),
      );
    }
  }

  const aliasRemote = aliasValue === undefined ? undefined : parseNamedRemote(aliasValue);
  if (aliasRemote !== undefined && Result.isFailure(aliasRemote)) {
    return Result.fail(
      new TargetInvalidValueError({
        flag: aliasFlag,
        message: `${aliasFlag} takes a project ref or a branch name, not a URL.`,
        suggestion:
          aliasRemote.failure.ref === undefined
            ? "Pass a project ref or a branch name, for example --remote=abcdefghijklmnopqrst"
            : `Use --remote=${aliasRemote.failure.ref}.`,
      }),
    );
  }

  const outcome = ((): {
    readonly selection: TargetSelection;
    readonly deprecations: ReadonlyArray<TargetDeprecation>;
  } => {
    if (input.local) return { selection: { _tag: "Local" }, deprecations: [{ kind: "local" }] };
    if (dbUrl !== undefined) {
      const value: RemoteValue = { _tag: "DbUrl", url: dbUrl };
      return {
        selection: value,
        deprecations: [{ kind: "remote-alias", flags: ["--db-url"], remote: value }],
      };
    }
    if (aliasRemote !== undefined && Result.isSuccess(aliasRemote)) {
      return {
        selection: aliasRemote.success,
        deprecations: [
          {
            kind: "remote-alias",
            flags: input.linked ? ["--linked", aliasFlag] : [aliasFlag],
            remote: aliasRemote.success,
          },
        ],
      };
    }
    if (input.linked) {
      const value: RemoteValue = { _tag: "Linked" };
      return {
        selection: value,
        deprecations: [{ kind: "remote-alias", flags: ["--linked"], remote: value }],
      };
    }
    if (remote !== undefined) return { selection: remote, deprecations: [] };
    return { selection: { _tag: "Default" }, deprecations: [] };
  })();

  if (input.dbUrl === undefined && outcome.selection._tag === "DbUrl") {
    return Result.fail(
      new TargetNeedsProjectError({
        message: `${options.commandName ?? "This command"} needs a project, not a database URL.`,
      }),
    );
  }
  return Result.succeed(outcome);
};
