import { Effect } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  LegacySnippetsDownloadNetworkError,
  LegacySnippetsDownloadUnexpectedStatusError,
  LegacySnippetsInvalidIdError,
} from "../snippets.errors.ts";
import type { LegacySnippetsDownloadFlags } from "./download.command.ts";

// Load-bearing for error-message parity. The generated `V1GetASnippetInput`
// schema (contracts.ts:1539-1545) already pattern-checks UUIDs, so if this
// pre-check is removed, a non-UUID input would surface as a `SchemaError`
// routed through `mapDownloadError` to `LegacySnippetsDownloadNetworkError`
// with a `failed to download snippet:` prefix — losing the Go-canonical
// `invalid snippet ID:` prefix from `apps/cli-go/internal/snippets/download/download.go:17`.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const mapDownloadError = mapLegacyHttpError({
  networkError: LegacySnippetsDownloadNetworkError,
  statusError: LegacySnippetsDownloadUnexpectedStatusError,
  networkMessage: (cause) => `failed to download snippet: ${cause}`,
  statusMessage: (status, body) => `unexpected download snippet status ${status}: ${body}`,
});

// Mirrors Go's `uuid.Parse` (google/uuid v1.6.0) error surface:
//   - len(s) not in {32, 36, 38, 41} → `invalid UUID length: N`
//   - len(s) == 36 but dashes/hex chars wrong → `invalid UUID format`
// We accept only the canonical 36-char form (`8-4-4-4-12`), so the two
// branches collapse to length-vs-format. The outer wrap mirrors
// `fmt.Errorf("invalid snippet ID: %w", err)` from download.go:17.
function uuidErrorMessage(value: string): string {
  if (value.length !== 36) {
    return `invalid snippet ID: invalid UUID length: ${value.length}`;
  }
  return "invalid snippet ID: invalid UUID format";
}

export const legacySnippetsDownload = Effect.fn("legacy.snippets.download")(function* (
  flags: LegacySnippetsDownloadFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  // Same lifecycle as `list` — see that handler for the Go cross-reference.
  // The UUID short-circuit lives inside the inner block so the linked-project
  // cache still fires (Go's PersistentPostRun runs after the failing Run).
  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      if (!UUID_RE.test(flags.snippetId)) {
        return yield* new LegacySnippetsInvalidIdError({
          message: uuidErrorMessage(flags.snippetId),
        });
      }

      const fetching =
        output.format === "text" ? yield* output.task("Downloading snippet...") : undefined;
      const response = yield* api.v1.getASnippet({ id: flags.snippetId }).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.catch(mapDownloadError),
      );
      yield* fetching?.clear() ?? Effect.void;

      // TS-only structured output. Expose the full payload so scripted callers
      // and agents can read snippet identity (`id`, `name`, `owner`, …)
      // alongside `content.sql`, matching the SIDE_EFFECTS.md contract and the
      // shape `snippets list --output-format json` uses for its response.
      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", response);
        return;
      }

      // Go's `download.Run` ignores `--output` entirely and always runs
      // `fmt.Println(resp.JSON200.Content.Sql)` (download.go:25). Mirror that:
      // no branching on `LegacyOutputFlag`.
      yield* output.raw(response.content.sql + "\n");
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
