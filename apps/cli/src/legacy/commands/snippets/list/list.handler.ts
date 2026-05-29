import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  LegacySnippetsEnvNotSupportedError,
  LegacySnippetsListNetworkError,
  LegacySnippetsListUnexpectedStatusError,
} from "../snippets.errors.ts";
import { renderSnippetsTable } from "../snippets.format.ts";
import type { LegacySnippetsListFlags } from "./list.command.ts";

const mapListError = mapLegacyHttpError({
  networkError: LegacySnippetsListNetworkError,
  statusError: LegacySnippetsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list snippets: ${cause}`,
  statusMessage: (status, body) => `unexpected list snippets status ${status}: ${body}`,
});

export const legacySnippetsList = Effect.fn("legacy.snippets.list")(function* (
  flags: LegacySnippetsListFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  // Mirror Go's lifecycle (apps/cli-go/cmd/root.go:93-167 + 175-183):
  //   PersistentPreRunE → resolve project ref
  //   Run               → reject --output env / call API / render
  //   PersistentPostRun → write linked-project cache (needs `ref`)
  //   Execute           → flush telemetry (no `ref` required)
  // The two `Effect.ensuring` blocks model the post-run order exactly:
  // `telemetryState.flush` runs on every exit, `linkedProjectCache.cache(ref)`
  // runs whenever ref resolution succeeded.
  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      if (Option.getOrUndefined(goOutputFlag) === "env") {
        return yield* new LegacySnippetsEnvNotSupportedError({
          message: "--output env flag is not supported",
        });
      }

      const fetching =
        output.format === "text" ? yield* output.task("Fetching snippets...") : undefined;
      const response = yield* api.v1.listAllSnippets({ project_ref: ref }).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.catch(mapListError),
      );
      yield* fetching?.clear() ?? Effect.void;

      const goFmt = Option.getOrUndefined(goOutputFlag);

      if (goFmt === "json") {
        // Go marshals `SnippetList{}` (nil Data slice) as `{"data": null}`;
        // the generated schema decodes nil → []. `nullForEmptyArrays` preserves
        // the Go-bytes shape for the empty-list fixture.
        yield* output.raw(encodeGoJson(response, { nullForEmptyArrays: ["data"] }));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeYaml(response));
        return;
      }
      if (goFmt === "toml") {
        yield* output.raw(encodeToml(response) + "\n");
        return;
      }

      // goFmt is undefined or "pretty" — defer to TS --output-format for
      // JSON/stream-json, otherwise render the Glamour table.
      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", response);
        return;
      }

      yield* output.raw(renderSnippetsTable(response.data));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
