import type { V1ListAllBranchesOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import { encodeGoToml, encodeGoYaml } from "../../../command-internal/go-struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { resolveParentScopedProjectRef } from "../../../command-internal/parent-project-ref.ts";
import { GO_BRANCHES_LIST, GO_BRANCHES_TOML_WRAPPER } from "../branches.go-payload.ts";
import {
  BranchesEnvNotSupportedError,
  BranchesListNetworkError,
  BranchesListUnexpectedStatusError,
} from "../branches.errors.ts";
import { renderBranchesListTable } from "../branches.format.ts";
import type { BranchesListFlags } from "./list.command.ts";

type Branches = typeof V1ListAllBranchesOutput.Type;

const mapListError = mapHttpError({
  networkError: BranchesListNetworkError,
  statusError: BranchesListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list branch: ${cause}`,
  statusMessage: (status, body) => `unexpected list branch status ${status}: ${body}`,
});

export const branchesList = Effect.fn("branches.list")(function* (flags: BranchesListFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // `branches` is PARENT-scoped: after `supabase link <branch>`,
  // `supabase/.temp/project-ref` holds the branch's own ref, and the platform
  // 403s on that ref for every branches-management endpoint (CLI-2167 follow-up).
  const ref = yield* resolveParentScopedProjectRef(flags.projectRef);

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
      return yield* new BranchesEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(branches));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeGoYaml(branches, GO_BRANCHES_LIST));
      return;
    }
    if (goFmt === "toml") {
      // Go builds the list with `append` (`list.go:70-80`), so an empty list
      // stays a nil slice and BurntSushi emits nothing for the wrapper.
      yield* output.raw(
        encodeGoToml(
          { branches: branches.length > 0 ? branches : undefined },
          GO_BRANCHES_TOML_WRAPPER,
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

    // Pretty text table only: mark the branch matching the CURRENTLY linked
    // ref as `(active)` — same soft chain `projects list` uses for its "you
    // are here" marker, never a prompt/failure. TS-only QoL (CLI-2167
    // follow-up, no Go counterpart); the machine payloads above stay untouched.
    const activeRef = yield* resolver.resolveOptional(Option.none());
    yield* output.raw(renderBranchesListTable(branches, Option.getOrUndefined(activeRef)));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
