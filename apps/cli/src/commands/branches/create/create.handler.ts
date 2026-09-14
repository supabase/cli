import type { V1CreateABranchOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag, resolveYes } from "../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../command-internal/prompt-yes-no.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../shared/output/errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { detectGitBranch } from "../../../shared/git/git-branch.ts";
import { aqua } from "../../../command-internal/colors.ts";
import { encodeEnv, encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import { encodeGoToml, encodeGoYaml } from "../../../command-internal/go-struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { resolveParentScopedProjectRef } from "../../../command-internal/parent-project-ref.ts";
import { gateMapError } from "../../../command-internal/upgrade-suggest.ts";
import { GO_BRANCH_RESPONSE } from "../branches.go-payload.ts";
import {
  BranchesBranchNameEmptyError,
  BranchesCreateCancelledError,
  BranchesCreateNetworkError,
  BranchesCreateUnexpectedStatusError,
} from "../branches.errors.ts";
import { renderBranchesListTable } from "../branches.format.ts";
import type { BranchesCreateFlags } from "./create.command.ts";

type CreatedBranch = typeof V1CreateABranchOutput.Type;

const mapCreateErrorRaw = mapHttpError({
  networkError: BranchesCreateNetworkError,
  statusError: BranchesCreateUnexpectedStatusError,
  networkMessage: (cause) => `failed to create preview branch: ${cause}`,
  statusMessage: (status, body) => `unexpected create branch status ${status}: ${body}`,
});

export const branchesCreate = Effect.fn("branches.create")(function* (flags: BranchesCreateFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // Branch-name resolution defaults to the current git branch when the arg is omitted, after a
  // Y/N prompt. Declining short-circuits before resolving the project ref, so the linked-project
  // cache write never fires.
  let branchName = Option.getOrElse(flags.name, () => "");
  // An explicit `--git-branch` flag takes precedence over the auto-detected branch.
  let gitBranchForBody = Option.getOrUndefined(flags.gitBranch);

  if (branchName.length === 0) {
    const gitBranch = yield* detectGitBranch();
    if (Option.isSome(gitBranch) && gitBranch.value.length > 0) {
      // `--yes`/`SUPABASE_YES` auto-confirms with a `<title> [Y/n] y` stderr echo; non-TTY
      // stdin scans one piped line (100ms) before falling back to Yes — `echo n | supabase
      // branches create` cancels.
      const yes = yield* resolveYes;
      const confirmed = yield* promptYesNo(
        output,
        yes,
        `Do you want to create a branch named ${aqua(gitBranch.value)}?`,
        true,
      );
      if (!confirmed) {
        return yield* new BranchesCreateCancelledError({ message: CONTEXT_CANCELED_MESSAGE });
      }
      branchName = gitBranch.value;
      if (gitBranchForBody === undefined) {
        gitBranchForBody = gitBranch.value;
      }
    }
  }

  if (branchName.length === 0) {
    return yield* new BranchesBranchNameEmptyError({
      message: "branch name cannot be empty",
    });
  }

  // `branches` is parent-scoped: after `supabase link <branch>`, `supabase/.temp/project-ref`
  // holds the branch's own ref, and the platform 403s on that ref for every branches-management
  // endpoint.
  const ref = yield* resolveParentScopedProjectRef(flags.projectRef);

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
        // Runs the plan-gate check before mapping the error, even for a gated 4xx.
        Effect.catch(
          gateMapError(
            { projectRef: ref, featureKey: "branching_limit" },
            (cause, upgradeSuggested) =>
              Effect.gen(function* () {
                const mapped = yield* Effect.flip(mapCreateErrorRaw(cause));
                if (mapped._tag === "BranchesCreateUnexpectedStatusError") {
                  return yield* Effect.fail(
                    new BranchesCreateUnexpectedStatusError({
                      status: mapped.status,
                      body: mapped.body,
                      message: mapped.message,
                      upgradeSuggested,
                    }),
                  );
                }
                return yield* Effect.fail(mapped);
              }),
          ),
        ),
      );
    yield* creating?.clear() ?? Effect.void;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    // "Created preview branch:" always writes first, then the table or encoded payload.
    if (goFmt === "json") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeGoJson(created));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeGoYaml(created, GO_BRANCH_RESPONSE));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeGoToml(created, GO_BRANCH_RESPONSE));
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
