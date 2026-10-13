import type { V1ListAllBranchesOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeSortedJson } from "../../../command-internal/output.encoders.ts";
import {
  encodeStructToml,
  encodeStructYaml,
} from "../../../command-internal/struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { resolveParentScopedProjectRef } from "../../../command-internal/parent-project-ref.ts";
import { BRANCHES_LIST_SHAPE, BRANCHES_TOML_WRAPPER_SHAPE } from "../branches.response-shape.ts";
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
  const outputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // `branches` is parent-scoped: after `supabase link <branch>`, `supabase/.temp/project-ref`
  // holds the branch's own ref, which the platform 403s on for every branches-management endpoint.
  const ref = yield* resolveParentScopedProjectRef(flags.projectRef);
  yield* Effect.annotateCurrentSpan("project.ref", ref);

  yield* Effect.gen(function* () {
    const fetching =
      output.format === "text" ? yield* output.task("Fetching branches...") : undefined;
    const branches: Branches = yield* api.v1.listAllBranches({ ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapListError),
    );
    yield* Effect.annotateCurrentSpan("branch.count", branches.length);
    yield* fetching?.clear ?? Effect.void;

    const outputFlagFormat = Option.getOrUndefined(outputFlag);

    if (outputFlagFormat === "env") {
      return yield* new BranchesEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (outputFlagFormat === "json") {
      yield* output.raw(encodeSortedJson(branches));
      return;
    }
    if (outputFlagFormat === "yaml") {
      yield* output.raw(encodeStructYaml(branches, BRANCHES_LIST_SHAPE));
      return;
    }
    if (outputFlagFormat === "toml") {
      // An empty branch list omits the `branches` key entirely rather than emitting `[]`.
      yield* output.raw(
        encodeStructToml(
          { branches: branches.length > 0 ? branches : undefined },
          BRANCHES_TOML_WRAPPER_SHAPE,
        ),
      );
      return;
    }

    // No --output flag (or "pretty"): fall back to --output-format.
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { branches });
      return;
    }

    // Marks the linked branch as `(active)`; resolveOptional never prompts or fails
    // when nothing is linked.
    const activeRef = yield* resolver.resolveOptional(Option.none());
    yield* output.raw(renderBranchesListTable(branches, Option.getOrUndefined(activeRef)));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
