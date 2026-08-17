import type { V1CreateABranchOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag, legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { legacyPromptYesNo } from "../../../../shared/legacy/legacy-prompt-yes-no.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../../shared/output/errors.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { detectGitBranch } from "../../../../shared/git/git-branch.ts";
import { legacyAqua } from "../../../shared/legacy-colors.ts";
import { encodeEnv, encodeGoJson } from "../../../shared/legacy-go-output.encoders.ts";
import {
  encodeLegacyGoToml,
  encodeLegacyGoYaml,
} from "../../../shared/legacy-go-struct-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { legacyResolveParentScopedProjectRef } from "../../../shared/legacy-parent-project-ref.ts";
import { legacyGateMapError } from "../../../shared/legacy-upgrade-suggest.ts";
import { LEGACY_GO_BRANCH_RESPONSE } from "../branches.go-payload.ts";
import {
  LegacyBranchesBranchNameEmptyError,
  LegacyBranchesCreateCancelledError,
  LegacyBranchesCreateNetworkError,
  LegacyBranchesCreateUnexpectedStatusError,
} from "../branches.errors.ts";
import { renderBranchesListTable } from "../branches.format.ts";
import type { LegacyBranchesCreateFlags } from "./create.command.ts";

type CreatedBranch = typeof V1CreateABranchOutput.Type;

const mapCreateErrorRaw = mapLegacyHttpError({
  networkError: LegacyBranchesCreateNetworkError,
  statusError: LegacyBranchesCreateUnexpectedStatusError,
  networkMessage: (cause) => `failed to create preview branch: ${cause}`,
  statusMessage: (status, body) => `unexpected create branch status ${status}: ${body}`,
});

export const legacyBranchesCreate = Effect.fn("legacy.branches.create")(function* (
  flags: LegacyBranchesCreateFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  // -----------------------------------------------------------------------
  // Branch-name resolution: defaults to the current git branch when the arg
  // is omitted, prompting Y/N first. The decline path returns
  // `context.Canceled` — tag-error and short-circuit before resolving the
  // project ref so the linked-project cache write does not fire.
  // -----------------------------------------------------------------------
  let branchName = Option.getOrElse(flags.name, () => "");
  // An explicit `--git-branch` flag takes precedence over the auto-detected
  // branch (the flag sets `body.GitBranch`, guarded during auto-detect).
  let gitBranchForBody = Option.getOrUndefined(flags.gitBranch);

  if (branchName.length === 0) {
    const gitBranch = yield* detectGitBranch();
    if (Option.isSome(gitBranch) && gitBranch.value.length > 0) {
      // Established prompt behavior: `--yes`/`SUPABASE_YES` auto-confirms
      // with the `<title> [Y/n] y` stderr echo instead of blocking a TTY,
      // and a non-TTY stdin prints the label and scans one piped line
      // (100ms) before falling back to the Yes default —
      // `echo n | supabase branches create` cancels. The branch name is
      // wrapped in `utils.Aqua`.
      const yes = yield* legacyResolveYes;
      const confirmed = yield* legacyPromptYesNo(
        output,
        yes,
        `Do you want to create a branch named ${legacyAqua(gitBranch.value)}?`,
        true,
      );
      if (!confirmed) {
        return yield* new LegacyBranchesCreateCancelledError({ message: CONTEXT_CANCELED_MESSAGE });
      }
      branchName = gitBranch.value;
      if (gitBranchForBody === undefined) {
        gitBranchForBody = gitBranch.value;
      }
    }
  }

  if (branchName.length === 0) {
    return yield* new LegacyBranchesBranchNameEmptyError({
      message: "branch name cannot be empty",
    });
  }

  // `branches` is PARENT-scoped: after `supabase link <branch>`,
  // `supabase/.temp/project-ref` holds the branch's own ref, and the platform
  // 403s on that ref for every branches-management endpoint (CLI-2167 follow-up).
  const ref = yield* legacyResolveParentScopedProjectRef(flags.projectRef);

  yield* Effect.gen(function* () {
    const creating =
      output.format === "text" ? yield* output.task("Creating branch...") : undefined;

    const created: CreatedBranch = yield* api.v1
      .createABranch({
        ref,
        branch_name: branchName,
        is_default: false,
        ...(gitBranchForBody !== undefined ? { git_branch: gitBranchForBody } : {}),
        ...(Option.isSome(flags.region) ? { region: flags.region.value } : {}),
        ...(Option.isSome(flags.size) ? { desired_instance_size: flags.size.value } : {}),
        ...(Option.isSome(flags.persistent) ? { persistent: flags.persistent.value } : {}),
        ...(Option.isSome(flags.withData) ? { with_data: flags.withData.value } : {}),
        ...(Option.isSome(flags.notifyUrl) ? { notify_url: flags.notifyUrl.value } : {}),
      })
      .pipe(
        Effect.tapError(() => creating?.fail() ?? Effect.void),
        // On any non-201 status (including gated 4xx), run the plan-gate
        // check before mapping the error.
        Effect.catch(
          legacyGateMapError(
            { projectRef: ref, featureKey: "branching_limit" },
            (cause, upgradeSuggested) => mapCreateErrorRaw(cause, { upgradeSuggested }),
          ),
        ),
      );
    yield* creating?.clear() ?? Effect.void;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    // Established output: "Created preview branch:" writes to stdout, then
    // the table or the encoded payload.
    if (goFmt === "json") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeGoJson(created));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeLegacyGoYaml(created, LEGACY_GO_BRANCH_RESPONSE));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeLegacyGoToml(created, LEGACY_GO_BRANCH_RESPONSE));
      return;
    }
    if (goFmt === "env") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeEnv(created) + "\n");
      return;
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("Created preview branch", { ...created });
      return;
    }

    yield* output.raw("Created preview branch:\n");
    yield* output.raw(renderBranchesListTable([created]));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
