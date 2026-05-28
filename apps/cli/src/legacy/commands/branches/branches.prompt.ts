import { styleText } from "node:util";

import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../auth/legacy-platform-api.service.ts";
import { mapLegacyHttpError } from "../../shared/legacy-http-errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { detectGitBranch } from "../../../shared/git/git-branch.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import {
  LegacyBranchesBranchNameEmptyError,
  LegacyBranchesBranchingDisabledError,
  LegacyBranchesListNetworkError,
  LegacyBranchesListUnexpectedStatusError,
} from "./branches.errors.ts";

const mapListError = mapLegacyHttpError({
  networkError: LegacyBranchesListNetworkError,
  statusError: LegacyBranchesListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list branch: ${cause}`,
  statusMessage: (status, body) => `unexpected list branch status ${status}: ${body}`,
});

/**
 * Reproduces Go's `promptBranchId` (`apps/cli-go/cmd/branches.go:230-269`).
 *
 *   - Non-TTY: read from stdin via `Output.promptText`. The prompt label
 *     includes the current git branch as a default when one is detected.
 *     If the user enters an empty string and no git branch is available,
 *     fail with "branch name cannot be empty".
 *   - TTY: call the list endpoint; if empty, fail with "branching is disabled".
 *     Otherwise present a `promptSelect` and write `"Selected branch ID: <ref>"`
 *     to stderr (text mode only — Go writes via `fmt.Fprintln(os.Stderr, ...)`).
 *
 * Used by `get`, `update`, `pause`, `unpause`, `delete` whenever the positional
 * `[name]` argument is omitted.
 */
export const legacyPromptBranchId = Effect.fnUntraced(function* (
  input: Option.Option<string>,
  projectRef: string,
) {
  if (Option.isSome(input) && input.value.length > 0) {
    return input.value;
  }

  const tty = yield* Tty;
  const output = yield* Output;

  if (!tty.stdinIsTty) {
    // Non-TTY path: read once from stdin, optionally with a git-branch default.
    const gitBranch = yield* detectGitBranch;
    const defaultBranch = Option.getOrElse(gitBranch, () => "");
    // Go applies `utils.Aqua(branchId)` to the default in the prompt label
    // (`apps/cli-go/cmd/branches.go:235`). lipgloss color "14" maps to ANSI
    // bright cyan; `styleText("cyan", ...)` is the closest faithful match.
    const label =
      defaultBranch.length > 0
        ? `Enter the name of your branch (or leave blank to use ${styleText("cyan", defaultBranch)}): `
        : "Enter the name of your branch: ";
    const entered = yield* output
      .promptText(label, { defaultValue: defaultBranch })
      .pipe(Effect.orElseSucceed(() => ""));
    const resolved = entered.length > 0 ? entered : defaultBranch;
    if (resolved.length === 0) {
      return yield* new LegacyBranchesBranchNameEmptyError({
        message: "branch name cannot be empty",
      });
    }
    return resolved;
  }

  // TTY path: list branches via the same endpoint as `branches list`, then
  // present a select prompt keyed by branch ref.
  const api = yield* LegacyPlatformApi;
  const branches = yield* api.v1
    .listAllBranches({ ref: projectRef })
    .pipe(Effect.catch(mapListError));
  if (branches.length === 0) {
    return yield* new LegacyBranchesBranchingDisabledError({
      message: "branching is disabled",
      // Go's `utils.CmdSuggestion` (`apps/cli-go/cmd/branches.go:252`).
      // The command name is wrapped in lipgloss color "14" (ANSI cyan).
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
