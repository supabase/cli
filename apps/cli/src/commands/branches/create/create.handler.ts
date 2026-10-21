import type { V1CreateABranchOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { requireHostedMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { detectGitBranch } from "../../../shared/git/git-branch.ts";
import { encodeEnv, encodeSortedJson } from "../../../command-internal/output.encoders.ts";
import {
  encodeStructToml,
  encodeStructYaml,
} from "../../../command-internal/struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { resolveProjectTarget } from "../../../command-internal/target/resolve-project-target.ts";
import { gateMapError } from "../../../command-internal/upgrade-suggest.ts";
import { BRANCH_RESPONSE_SHAPE } from "../branches.response-shape.ts";
import {
  BranchesBranchNameEmptyError,
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
  const outputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // The name defaults to the current git branch when the arg is omitted.
  let branchName = Option.getOrElse(flags.name, () => "");
  // An explicit `--git-branch` flag takes precedence over the auto-detected branch.
  let gitBranchForBody = Option.getOrUndefined(flags.gitBranch);
  let nameFromGitBranch = false;

  if (branchName.length === 0) {
    const gitBranch = yield* detectGitBranch();
    if (Option.isSome(gitBranch) && gitBranch.value.length > 0) {
      branchName = gitBranch.value;
      nameFromGitBranch = true;
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
  const ref = yield* resolveProjectTarget(
    { remote: flags.remote, projectRef: flags.projectRef },
    { parent: true },
  );
  yield* Effect.annotateCurrentSpan("project.ref", ref);

  yield* Effect.gen(function* () {
    yield* requireHostedMutationConsent({
      action: `Create preview branch ${branchName}`,
      details: [
        ...(nameFromGitBranch ? ["Branch name taken from the current git branch"] : []),
        ...(Option.isSome(flags.region) ? [`Region: ${flags.region.value}`] : []),
        ...(Option.isSome(flags.size) ? [`Instance size: ${flags.size.value}`] : []),
        ...(Option.isSome(flags.persistent) ? [`Persistent: ${flags.persistent.value}`] : []),
        ...(Option.isSome(flags.withData) ? [`With production data: ${flags.withData.value}`] : []),
      ],
    });

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
              mapCreateErrorRaw(cause).pipe(
                Effect.catchTag("BranchesCreateUnexpectedStatusError", (mapped) =>
                  Effect.fail(
                    new BranchesCreateUnexpectedStatusError({
                      status: mapped.status,
                      body: mapped.body,
                      message: mapped.message,
                      upgradeSuggested,
                    }),
                  ),
                ),
              ),
          ),
        ),
      );
    yield* creating?.clear ?? Effect.void;

    const outputFlagFormat = Option.getOrUndefined(outputFlag);

    // "Created preview branch:" always writes first, then the table or encoded payload.
    if (outputFlagFormat === "json") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeSortedJson(created));
      return;
    }
    if (outputFlagFormat === "yaml") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeStructYaml(created, BRANCH_RESPONSE_SHAPE));
      return;
    }
    if (outputFlagFormat === "toml") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeStructToml(created, BRANCH_RESPONSE_SHAPE));
      return;
    }
    if (outputFlagFormat === "env") {
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
