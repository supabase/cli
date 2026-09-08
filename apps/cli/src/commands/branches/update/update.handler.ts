import type { V1UpdateABranchConfigInput, V1UpdateABranchConfigOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { encodeEnv, encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import { encodeGoToml, encodeGoYaml } from "../../../command-internal/go-struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { resolveParentScopedProjectRef } from "../../../command-internal/parent-project-ref.ts";
import { gateMapError } from "../../../command-internal/upgrade-suggest.ts";
import { GO_BRANCH_RESPONSE } from "../branches.go-payload.ts";
import {
  BranchesUpdateNetworkError,
  BranchesUpdateUnexpectedStatusError,
} from "../branches.errors.ts";
import { renderBranchesListTable } from "../branches.format.ts";
import { promptBranchId } from "../branches.prompt.ts";
import { resolveBranchProjectRef } from "../branches.resolver.ts";
import type { BranchesUpdateFlags } from "./update.command.ts";

type UpdatedBranch = typeof V1UpdateABranchConfigOutput.Type;
type UpdateInput = typeof V1UpdateABranchConfigInput.Type;
type BranchStatus = NonNullable<UpdateInput["status"]>;

const mapUpdateError = mapHttpError({
  networkError: BranchesUpdateNetworkError,
  statusError: BranchesUpdateUnexpectedStatusError,
  networkMessage: (cause) => `failed to update preview branch: ${cause}`,
  statusMessage: (status, body) => `unexpected update branch status ${status}: ${body}`,
});

export const branchesUpdate = Effect.fn("branches.update")(function* (flags: BranchesUpdateFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  // Force `Tty` into the handler's R channel so `promptBranchId` (which
  // requires it) resolves. The yielded value itself is unused.
  void (yield* Tty);

  // `branches` is PARENT-scoped: after `supabase link <branch>`,
  // `supabase/.temp/project-ref` holds the branch's own ref, and the platform
  // 403s on that ref for every branches-management endpoint (CLI-2167 follow-up).
  const ref = yield* resolveParentScopedProjectRef(flags.projectRef);

  yield* Effect.gen(function* () {
    const branchInput = yield* promptBranchId(flags.branchId, ref);
    const branchRef = yield* resolveBranchProjectRef(branchInput, ref);

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
          gateMapError(
            { projectRef: branchRef, featureKey: "branching_persistent" },
            (cause, upgradeSuggested) =>
              Effect.gen(function* () {
                const mapped = yield* Effect.flip(mapUpdateError(cause));
                if (mapped._tag === "BranchesUpdateUnexpectedStatusError") {
                  return yield* Effect.fail(
                    new BranchesUpdateUnexpectedStatusError({
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
      yield* output.raw(encodeGoYaml(updated, GO_BRANCH_RESPONSE));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw("Updated preview branch:\n", "stderr");
      yield* output.raw(encodeGoToml(updated, GO_BRANCH_RESPONSE));
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
