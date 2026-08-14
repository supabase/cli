import type { V1UpdateABranchConfigInput, V1UpdateABranchConfigOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
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
  LegacyBranchesUpdateNetworkError,
  LegacyBranchesUpdateUnexpectedStatusError,
} from "../branches.errors.ts";
import { renderBranchesListTable } from "../branches.format.ts";
import { legacyPromptBranchId } from "../branches.prompt.ts";
import { legacyResolveBranchProjectRef } from "../branches.resolver.ts";
import type { LegacyBranchesUpdateFlags } from "./update.command.ts";

type UpdatedBranch = typeof V1UpdateABranchConfigOutput.Type;
type UpdateInput = typeof V1UpdateABranchConfigInput.Type;
type BranchStatus = NonNullable<UpdateInput["status"]>;

const mapUpdateError = mapLegacyHttpError({
  networkError: LegacyBranchesUpdateNetworkError,
  statusError: LegacyBranchesUpdateUnexpectedStatusError,
  networkMessage: (cause) => `failed to update preview branch: ${cause}`,
  statusMessage: (status, body) => `unexpected update branch status ${status}: ${body}`,
});

export const legacyBranchesUpdate = Effect.fn("legacy.branches.update")(function* (
  flags: LegacyBranchesUpdateFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  // Force `Tty` into the handler's R channel so `legacyPromptBranchId` (which
  // requires it) resolves. The yielded value itself is unused.
  void (yield* Tty);

  // `branches` is PARENT-scoped: after `supabase link <branch>`,
  // `supabase/.temp/project-ref` holds the branch's own ref, and the platform
  // 403s on that ref for every branches-management endpoint (CLI-2167 follow-up).
  const ref = yield* legacyResolveParentScopedProjectRef(flags.projectRef);

  yield* Effect.gen(function* () {
    const branchInput = yield* legacyPromptBranchId(flags.branchId, ref);
    const branchRef = yield* legacyResolveBranchProjectRef(branchInput, ref);

    const patching =
      output.format === "text" ? yield* output.task("Updating branch...") : undefined;

    const updated: UpdatedBranch = yield* api.v1
      .updateABranchConfig({
        branch_id_or_ref: branchRef,
        ...(Option.isSome(flags.name) ? { branch_name: flags.name.value } : {}),
        ...(Option.isSome(flags.gitBranch) ? { git_branch: flags.gitBranch.value } : {}),
        ...(Option.isSome(flags.persistent) ? { persistent: flags.persistent.value } : {}),
        ...(Option.isSome(flags.status) ? { status: flags.status.value as BranchStatus } : {}),
        ...(Option.isSome(flags.notifyUrl) ? { notify_url: flags.notifyUrl.value } : {}),
      })
      .pipe(
        Effect.tapError(() => patching?.fail() ?? Effect.void),
        // Pass the resolved branch's project ref so the entitlements check
        // is scoped to the branch's org.
        Effect.catch(
          legacyGateMapError(
            { projectRef: branchRef, featureKey: "branching_persistent" },
            (cause, upgradeSuggested) => mapUpdateError(cause, { upgradeSuggested }),
          ),
        ),
      );
    yield* patching?.clear() ?? Effect.void;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    // Go writes "Updated preview branch:" to STDERR (`fmt.Fprintln(os.Stderr, ...)`),
    // then the payload to stdout via EncodeOutput / RenderTable.
    if (goFmt === "json") {
      yield* output.raw("Updated preview branch:\n", "stderr");
      yield* output.raw(encodeGoJson(updated));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw("Updated preview branch:\n", "stderr");
      yield* output.raw(encodeLegacyGoYaml(updated, LEGACY_GO_BRANCH_RESPONSE));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw("Updated preview branch:\n", "stderr");
      yield* output.raw(encodeLegacyGoToml(updated, LEGACY_GO_BRANCH_RESPONSE));
      return;
    }
    if (goFmt === "env") {
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
