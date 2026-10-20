import { Option, Result } from "effect";

import {
  parseNamedRemote,
  type NamedRemoteRejection,
  type NamedRemoteValue,
  type RemoteValue,
} from "./remote-value.ts";
import type { TargetFlagValues } from "./target-flags.ts";
import {
  TargetEmptyValueError,
  TargetInvalidValueError,
  TargetProjectRefConflictError,
  TargetSelectorConflictError,
  type TargetSelectorError,
} from "./target.errors.ts";

/** What the flags select: the default, the local stack, or a remote project, branch or database. */
type TargetSelection = { readonly _tag: "Default" } | { readonly _tag: "Local" } | RemoteValue;

/** Whether any selector flag, `--local` and the deprecated aliases included, was given. */
export const hasExplicitSelector = (flags: TargetFlagValues): boolean =>
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
  /** What `--remote` takes here, for suggestions; defaults to `<ref|branch>` without `dbUrl`. */
  readonly valueHint?: string;
  /** `--remote` is given more than once with values that differ. */
  readonly remoteConflict?: boolean;
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

/** Why an alias value is unusable: a foreign URL, a keyword DSN, or a URL with no database. */
const aliasRejection = (
  parsed: Result.Result<NamedRemoteValue, NamedRemoteRejection> | undefined,
  hasDatabase: boolean,
): NamedRemoteRejection | undefined => {
  if (parsed === undefined) return undefined;
  if (Result.isFailure(parsed)) return parsed.failure;
  return parsed.success._tag === "DbUrl" && !hasDatabase
    ? { _tag: "ForeignUrl", ref: undefined }
    : undefined;
};

/**
 * A `false` switch counts as absent, so `--linked=false` and `--no-linked` select nothing.
 * `--linked`, `--project-ref`, `--project-id` and `--db-url` resolve exactly like the `--remote`
 * form they map to and are reported as deprecations; `--local` selects the default.
 */
export const parseTargetSelector = (
  input: TargetFlagValues,
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

  if (options.remoteConflict === true) {
    return Result.fail(
      new TargetSelectorConflictError({
        flags: ["--remote"],
        message: "--remote is given more than once with different values; pass it once.",
        suggestion: `Pass --remote once, as --remote or --remote=${valueHint}.`,
      }),
    );
  }

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
  const rejectedAlias = aliasRejection(aliasRemote, input.dbUrl !== undefined);
  if (rejectedAlias !== undefined) {
    return Result.fail(
      new TargetInvalidValueError({
        flag: aliasFlag,
        message: `${aliasFlag} takes a project ref or a branch name, not a ${rejectedAlias._tag === "ForeignUrl" ? "URL" : "connection string"}.`,
        suggestion:
          rejectedAlias._tag === "ForeignUrl" && rejectedAlias.ref !== undefined
            ? `Use --remote=${rejectedAlias.ref}.`
            : "Pass a project ref or a branch name, for example --remote=abcdefghijklmnopqrst",
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

  return Result.succeed(outcome);
};
