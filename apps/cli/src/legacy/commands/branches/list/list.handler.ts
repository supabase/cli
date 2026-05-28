import type { V1ListAllBranchesOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
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
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

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
      yield* output.raw(encodeYaml(branches));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeToml({ branches }) + "\n");
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
