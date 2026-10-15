import { Option, Result } from "effect";

import {
  TargetEmptyValueError,
  TargetProjectRefConflictError,
  TargetSelectorConflictError,
  type TargetSelectorError,
} from "./target.errors.ts";

export interface TargetSelectorInput {
  readonly local: boolean;
  readonly linked: boolean;
  readonly dbUrl: Option.Option<string>;
  readonly projectRef: Option.Option<string>;
}

export type TargetSelection =
  | { readonly explicit: "local" }
  | { readonly explicit: "db-url"; readonly url: string }
  | { readonly explicit: "linked"; readonly projectRef: Option.Option<string> }
  | { readonly explicit: undefined };

const joinFlags = (flags: ReadonlyArray<string>): string =>
  flags.length <= 2
    ? flags.join(" and ")
    : `${flags.slice(0, -1).join(", ")} and ${flags[flags.length - 1]}`;

/** A `false` switch counts as absent, so `--linked=false` and `--no-linked` select nothing. */
export const parseTargetSelector = (
  input: TargetSelectorInput,
): Result.Result<TargetSelection, TargetSelectorError> => {
  const dbUrl = Option.getOrUndefined(input.dbUrl);
  const projectRef = Option.getOrUndefined(input.projectRef);

  if (dbUrl === "") {
    return Result.fail(
      new TargetEmptyValueError({ flag: "--db-url", message: "--db-url cannot be empty." }),
    );
  }
  if (projectRef === "") {
    return Result.fail(
      new TargetEmptyValueError({
        flag: "--project-ref",
        message: "--project-ref cannot be empty.",
      }),
    );
  }

  const selected = [
    ...(input.local ? ["--local"] : []),
    ...(input.linked ? ["--linked"] : []),
    ...(dbUrl === undefined ? [] : ["--db-url"]),
  ];
  if (selected.length > 1) {
    return Result.fail(
      new TargetSelectorConflictError({
        flags: selected,
        message: `Only one of --local, --linked and --db-url can be set; got ${joinFlags(selected)}.`,
      }),
    );
  }

  if (projectRef !== undefined && (input.local || dbUrl !== undefined)) {
    const conflictsWith = input.local ? "--local" : "--db-url";
    return Result.fail(
      new TargetProjectRefConflictError({
        conflictsWith,
        message: `--project-ref selects a linked project and cannot be combined with ${conflictsWith}.`,
      }),
    );
  }

  if (input.local) return Result.succeed({ explicit: "local" });
  if (dbUrl !== undefined) return Result.succeed({ explicit: "db-url", url: dbUrl });
  if (input.linked || projectRef !== undefined) {
    return Result.succeed({ explicit: "linked", projectRef: input.projectRef });
  }
  return Result.succeed({ explicit: undefined });
};
