import { styleText } from "node:util";

import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { mapHttpError } from "../../command-internal/http-errors.ts";
import { Output } from "../../shared/output/output.service.ts";
import { detectGitBranch } from "../../shared/git/git-branch.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import {
  BranchesBranchNameEmptyError,
  BranchesBranchingDisabledError,
  BranchesListNetworkError,
  BranchesListUnexpectedStatusError,
} from "./branches.errors.ts";

const mapListError = mapHttpError({
  networkError: BranchesListNetworkError,
  statusError: BranchesListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list branch: ${cause}`,
  statusMessage: (status, body) => `unexpected list branch status ${status}: ${body}`,
});

/**
 * Prompts for a branch identifier when the positional `[name]` argument is omitted: non-TTY
 * reads stdin with a git-branch default, failing with "branch name cannot be empty" if both are
 * empty; TTY lists branches and presents a `promptSelect`, failing with "branching is disabled"
 * if none exist.
 *
 * Used by `get`, `update`, `pause`, `unpause`, `delete`.
 */
export const promptBranchId = Effect.fnUntraced(function* (
  input: Option.Option<string>,
  projectRef: string,
) {
  if (Option.isSome(input) && input.value.length > 0) {
    return input.value;
  }

  const tty = yield* Tty;
  const output = yield* Output;

  if (!tty.stdinIsTty) {
    const gitBranch = yield* detectGitBranch();
    const defaultBranch = Option.getOrElse(gitBranch, () => "");
    // Cyan matches the established color for this default value.
    const label =
      defaultBranch.length > 0
        ? `Enter the name of your branch (or leave blank to use ${styleText("cyan", defaultBranch)}): `
        : "Enter the name of your branch: ";
    const entered = yield* output
      .promptText(label, { defaultValue: defaultBranch })
      .pipe(Effect.orElseSucceed(() => ""));
    const resolved = entered.length > 0 ? entered : defaultBranch;
    if (resolved.length === 0) {
      return yield* new BranchesBranchNameEmptyError({
        message: "branch name cannot be empty",
      });
    }
    return resolved;
  }

  const api = yield* CommandPlatformApi;
  const branches = yield* api.v1
    .listAllBranches({ ref: projectRef })
    .pipe(Effect.catch(mapListError));
  if (branches.length === 0) {
    return yield* new BranchesBranchingDisabledError({
      message: "branching is disabled",
      // Cyan matches the established color for the suggested command.
      suggestion: `Create your first branch with: ${styleText("cyan", "supabase branches create")}`,
    });
  }

  const options = branches.map((branch) => ({
    value: branch.project_ref,
    label: branch.name,
    hint: branch.project_ref,
  }));

  const choice = yield* output
    .promptSelect("Select a branch:", options)
    .pipe(Effect.orElseSucceed(() => options[0]!.value));

  if (output.format === "text") {
    yield* output.raw(`Selected branch ID: ${choice}\n`, "stderr");
  }
  return choice;
});
