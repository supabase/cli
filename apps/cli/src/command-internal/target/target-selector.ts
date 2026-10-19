import { Option, Result } from "effect";

import { classifyNamedRemote, type RemoteValue } from "./remote-value.ts";
import {
  TargetEmptyValueError,
  TargetNeedsProjectError,
  TargetProjectRefConflictError,
  TargetSelectorConflictError,
  type TargetSelectorError,
} from "./target.errors.ts";

export interface TargetSelectorInput {
  readonly remote: Option.Option<RemoteValue>;
  readonly local: boolean;
  readonly linked: boolean;
  /** Absent for a command with no database connection, which rejects a database URL. */
  readonly dbUrl?: Option.Option<string>;
  readonly projectRef: Option.Option<string>;
  /** `gen types` only: the deprecated alias of `--project-ref`. */
  readonly projectId?: Option.Option<string>;
}

type TargetSelection =
  | { readonly explicit: "local" }
  | { readonly explicit: "db-url"; readonly url: string }
  | { readonly explicit: "linked"; readonly ref: Option.Option<string> }
  | { readonly explicit: "branch"; readonly name: string }
  | { readonly explicit: undefined };

export type RemoteAliasFlag = "--linked" | "--project-ref" | "--project-id" | "--db-url";

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
}

/** Lists flag names as `a`, `a and b` or `a, b and c`. */
export const joinFlags = (flags: ReadonlyArray<string>): string =>
  flags.length <= 2
    ? flags.join(" and ")
    : `${flags.slice(0, -1).join(", ")} and ${flags[flags.length - 1]}`;

const selectionOf = (remote: RemoteValue): TargetSelection => {
  switch (remote._tag) {
    case "Linked":
      return { explicit: "linked", ref: Option.none() };
    case "Ref":
      return { explicit: "linked", ref: Option.some(remote.ref) };
    case "DbUrl":
      return { explicit: "db-url", url: remote.url };
    case "Branch":
      return { explicit: "branch", name: remote.name };
  }
};

const emptyValueError = (flag: "--db-url" | "--project-ref" | "--project-id") =>
  new TargetEmptyValueError({
    flag,
    message: `${flag} cannot be empty.`,
    suggestion:
      flag === "--db-url"
        ? "Pass a connection string, for example --remote=postgresql://postgres:postgres@127.0.0.1:54322/postgres"
        : "Pass a project ref, for example --remote=abcdefghijklmnopqrst",
  });

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
  const dbUrl = Option.getOrUndefined(input.dbUrl ?? Option.none());
  const projectRef = Option.getOrUndefined(input.projectRef);
  const projectId = Option.getOrUndefined(input.projectId ?? Option.none());

  if (dbUrl === "") return Result.fail(emptyValueError("--db-url"));
  if (projectRef === "") return Result.fail(emptyValueError("--project-ref"));
  if (projectId === "") return Result.fail(emptyValueError("--project-id"));

  const selected = [
    ...(remote === undefined ? [] : ["--remote"]),
    ...(input.linked ? ["--linked"] : []),
    ...(dbUrl === undefined ? [] : ["--db-url"]),
    ...(input.local ? ["--local"] : []),
  ];
  if (selected.length > 1) {
    return Result.fail(
      new TargetSelectorConflictError({
        flags: selected,
        message: `Only one of --remote, --linked, --db-url and --local can be set; got ${joinFlags(selected)}.`,
      }),
    );
  }

  if (projectRef !== undefined && projectId !== undefined) {
    return Result.fail(
      new TargetSelectorConflictError({
        flags: ["--project-id", "--project-ref"],
        message: "--project-id is a deprecated alias of --project-ref; pass only one of them.",
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
              ? `${aliasFlag} cannot be combined with --remote=<value>; use --remote=<ref> alone.`
              : `${aliasFlag} selects a remote project and cannot be combined with ${conflictsWith}.`,
        }),
      );
    }
  }

  const outcome = ((): {
    readonly selection: TargetSelection;
    readonly deprecations: ReadonlyArray<TargetDeprecation>;
  } => {
    if (input.local) return { selection: { explicit: "local" }, deprecations: [{ kind: "local" }] };
    if (dbUrl !== undefined) {
      return {
        selection: { explicit: "db-url", url: dbUrl },
        deprecations: [
          { kind: "remote-alias", flags: ["--db-url"], remote: { _tag: "DbUrl", url: dbUrl } },
        ],
      };
    }
    if (aliasValue !== undefined) {
      const value = classifyNamedRemote(aliasValue);
      return {
        selection: selectionOf(value),
        deprecations: [
          {
            kind: "remote-alias",
            flags: input.linked ? ["--linked", aliasFlag] : [aliasFlag],
            remote: value,
          },
        ],
      };
    }
    if (input.linked) {
      const value: RemoteValue = { _tag: "Linked" };
      return {
        selection: selectionOf(value),
        deprecations: [{ kind: "remote-alias", flags: ["--linked"], remote: value }],
      };
    }
    if (remote !== undefined) return { selection: selectionOf(remote), deprecations: [] };
    return { selection: { explicit: undefined }, deprecations: [] };
  })();

  if (input.dbUrl === undefined && outcome.selection.explicit === "db-url") {
    return Result.fail(
      new TargetNeedsProjectError({
        message: `${options.commandName ?? "This command"} needs a project, not a database URL.`,
      }),
    );
  }
  return Result.succeed(outcome);
};
