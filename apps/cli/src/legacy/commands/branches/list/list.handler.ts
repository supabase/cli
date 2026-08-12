import type { V1ListAllBranchesOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { encodeGoJson } from "../../../shared/legacy-go-output.encoders.ts";
import {
  encodeLegacyGoToml,
  encodeLegacyGoYaml,
} from "../../../shared/legacy-go-struct-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { legacyResolveParentScopedProjectRef } from "../../../shared/legacy-parent-project-ref.ts";
import {
  LEGACY_GO_BRANCHES_LIST,
  LEGACY_GO_BRANCHES_TOML_WRAPPER,
} from "../branches.go-payload.ts";
import {
  LegacyBranchesEnvNotSupportedError,
  LegacyBranchesListNetworkError,
  LegacyBranchesListUnexpectedStatusError,
} from "../branches.errors.ts";
import { renderBranchesListTable } from "../branches.format.ts";
import type { LegacyBranchesListFlags } from "./list.command.ts";

type Branches = typeof V1ListAllBranchesOutput.Type;

const mapListError = mapLegacyHttpError({
  networkError: LegacyBranchesListNetworkError,
  statusError: LegacyBranchesListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list branch: ${cause}`,
  statusMessage: (status, body) => `unexpected list branch status ${status}: ${body}`,
});

export const legacyBranchesList = Effect.fn("legacy.branches.list")(function* (
  flags: LegacyBranchesListFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  // `branches` is PARENT-scoped: after `supabase link <branch>`,
  // `supabase/.temp/project-ref` holds the branch's own ref, and the platform
  // 403s on that ref for every branches-management endpoint (CLI-2167 follow-up).
  const ref = yield* legacyResolveParentScopedProjectRef(flags.projectRef);

  yield* Effect.gen(function* () {
    const fetching =
      output.format === "text" ? yield* output.task("Fetching branches...") : undefined;
    const branches: Branches = yield* api.v1.listAllBranches({ ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapListError),
    );
    yield* fetching?.clear() ?? Effect.void;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "env") {
      return yield* new LegacyBranchesEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(branches));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeLegacyGoYaml(branches, LEGACY_GO_BRANCHES_LIST));
      return;
    }
    if (goFmt === "toml") {
      // Go builds the list with `append` (`list.go:70-80`), so an empty list
      // stays a nil slice and BurntSushi emits nothing for the wrapper.
      yield* output.raw(
        encodeLegacyGoToml(
          { branches: branches.length > 0 ? branches : undefined },
          LEGACY_GO_BRANCHES_TOML_WRAPPER,
        ),
      );
      return;
    }

    // goFmt is undefined or "pretty" — defer to TS --output-format for
    // JSON/stream-json, otherwise render the Glamour-styled table.
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { branches });
      return;
    }

    yield* output.raw(renderBranchesListTable(branches));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
