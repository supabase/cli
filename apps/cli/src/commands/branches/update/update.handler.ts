import type { V1UpdateABranchConfigOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeEnv, encodeSortedJson } from "../../../command-internal/output.encoders.ts";
import {
  encodeStructToml,
  encodeStructYaml,
} from "../../../command-internal/struct-output.encoders.ts";
import { requireHostedMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { resolveParentScopedProjectRef } from "../../../command-internal/parent-project-ref.ts";
import { gateMapError } from "../../../command-internal/upgrade-suggest.ts";
import { BRANCH_RESPONSE_SHAPE } from "../branches.response-shape.ts";
import {
  BranchesUpdateNetworkError,
  BranchesUpdateUnexpectedStatusError,
} from "../branches.errors.ts";
import { renderBranchesListTable } from "../branches.format.ts";
import { promptBranchId } from "../branches.prompt.ts";
import { resolveBranchProjectRef } from "../branches.resolver.ts";
import type { BranchesUpdateFlags } from "./update.command.ts";

type UpdatedBranch = typeof V1UpdateABranchConfigOutput.Type;

const mapUpdateError = mapHttpError({
  networkError: BranchesUpdateNetworkError,
  statusError: BranchesUpdateUnexpectedStatusError,
  networkMessage: (cause) => `failed to update preview branch: ${cause}`,
  statusMessage: (status, body) => `unexpected update branch status ${status}: ${body}`,
});

export const branchesUpdate = Effect.fn("branches.update")(function* (flags: BranchesUpdateFlags) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // `branches` is parent-scoped: after `supabase link <branch>`, `supabase/.temp/project-ref`
  // holds the branch's own ref, which the platform 403s on for every branches-management endpoint.
  const ref = yield* resolveParentScopedProjectRef(flags.projectRef);
  yield* Effect.annotateCurrentSpan("project.ref", ref);

  yield* Effect.gen(function* () {
    const branchInput = yield* promptBranchId(flags.branchId, ref);
    const branchRef = yield* resolveBranchProjectRef(branchInput, ref);

    yield* requireHostedMutationConsent({
      action: `Update preview branch ${branchInput}`,
      details: [
        `Branch project ref: ${branchRef}`,
        ...(Option.isSome(flags.name) ? [`Rename to: ${flags.name.value}`] : []),
        ...(Option.isSome(flags.gitBranch) ? [`Git branch: ${flags.gitBranch.value}`] : []),
        ...(Option.isSome(flags.persistent) ? [`Persistent: ${flags.persistent.value}`] : []),
        ...(Option.isSome(flags.status) ? [`Status: ${flags.status.value}`] : []),
        ...(Option.isSome(flags.notifyUrl) ? [`Notify URL: ${flags.notifyUrl.value}`] : []),
      ],
    });

    const patching =
      output.format === "text" ? yield* output.task("Updating branch...") : undefined;

    const updated: UpdatedBranch = yield* api.v1
      .updateABranchConfig({
        branch_id_or_ref: branchRef,
        ...(Option.isSome(flags.name) ? { branch_name: flags.name.value } : {}),
        ...(Option.isSome(flags.gitBranch) ? { git_branch: flags.gitBranch.value } : {}),
        ...(Option.isSome(flags.persistent) ? { persistent: flags.persistent.value } : {}),
        ...(Option.isSome(flags.status) ? { status: flags.status.value } : {}),
        ...(Option.isSome(flags.notifyUrl) ? { notify_url: flags.notifyUrl.value } : {}),
      })
      .pipe(
        Effect.tapError(() => patching?.fail() ?? Effect.void),
        // Scopes the entitlements check to the branch's own org via its resolved project ref.
        Effect.catch(
          gateMapError(
            { projectRef: branchRef, featureKey: "branching_persistent" },
            (cause, upgradeSuggested) =>
              mapUpdateError(cause).pipe(
                Effect.catchTag("BranchesUpdateUnexpectedStatusError", (mapped) =>
                  Effect.fail(
                    new BranchesUpdateUnexpectedStatusError({
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
    yield* patching?.clear ?? Effect.void;

    const outputFlagFormat = Option.getOrUndefined(outputFlag);

    // The confirmation message goes to stderr; the payload always goes to stdout.
    if (outputFlagFormat === "json") {
      yield* output.raw("Updated preview branch:\n", "stderr");
      yield* output.raw(encodeSortedJson(updated));
      return;
    }
    if (outputFlagFormat === "yaml") {
      yield* output.raw("Updated preview branch:\n", "stderr");
      yield* output.raw(encodeStructYaml(updated, BRANCH_RESPONSE_SHAPE));
      return;
    }
    if (outputFlagFormat === "toml") {
      yield* output.raw("Updated preview branch:\n", "stderr");
      yield* output.raw(encodeStructToml(updated, BRANCH_RESPONSE_SHAPE));
      return;
    }
    if (outputFlagFormat === "env") {
      yield* output.raw("Updated preview branch:\n", "stderr");
      yield* output.raw(encodeEnv(updated) + "\n");
      return;
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("Updated preview branch", { ...updated });
      return;
    }

    yield* output.raw("Updated preview branch:\n", "stderr");
    yield* output.raw(renderBranchesListTable([updated]));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
