import { Effect, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { resolveLegacyAccessToken } from "../../../shared/legacy-resolve-token.ts";
import { sanitizeLegacyErrorBody } from "../../../shared/legacy-http-errors.ts";
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

// Tolerant body parse — see `list.handler.ts` for the rationale. The real
// `/v1/snippets/{id}` payload omits `description`, which the generated
// `V1GetASnippetOutput` schema declares as `Union[String, Null]` (required).
// Routing through the typed client surfaces `SchemaError: Missing key …` on
// every non-test response. Same workaround as `legacy-linked-project-cache.layer.ts`.
function asRecord(obj: unknown): Record<string, unknown> {
  return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : {};
}

function readSql(body: unknown): string {
  const content = asRecord(asRecord(body)["content"]);
  const sql = content["sql"];
  return typeof sql === "string" ? sql : "";
}

export const legacySnippetsDownload = Effect.fn("legacy.snippets.download")(function* (
  flags: LegacySnippetsDownloadFlags,
) {
  const output = yield* Output;
  const httpClient = yield* HttpClient.HttpClient;
  const cliConfig = yield* LegacyCliConfig;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      if (!UUID_RE.test(flags.snippetId)) {
        return yield* new LegacySnippetsInvalidIdError({
          message: uuidErrorMessage(flags.snippetId),
        });
      }

      const tokenOpt = yield* resolveLegacyAccessToken;
      const authHeader: (
        req: HttpClientRequest.HttpClientRequest,
      ) => HttpClientRequest.HttpClientRequest = Option.isSome(tokenOpt)
        ? HttpClientRequest.bearerToken(tokenOpt.value)
        : (req) => req;
      const request = HttpClientRequest.get(
        `${cliConfig.apiUrl}/v1/snippets/${flags.snippetId}`,
      ).pipe(authHeader, HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent));

      const fetching =
        output.format === "text" ? yield* output.task("Downloading snippet...") : undefined;
      const response = yield* httpClient.execute(request).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.catch(
          (cause) =>
            new LegacySnippetsDownloadNetworkError({
              message: `failed to download snippet: ${cause.reason.description ?? cause.reason._tag}`,
            }),
        ),
      );

      if (response.status !== 200) {
        yield* fetching?.fail() ?? Effect.void;
        const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        const body = sanitizeLegacyErrorBody(rawBody);
        return yield* new LegacySnippetsDownloadUnexpectedStatusError({
          status: response.status,
          body,
          message: `unexpected download snippet status ${response.status}: ${body}`,
        });
      }

      const rawBody = yield* response.json.pipe(
        Effect.catch(
          (cause) =>
            new LegacySnippetsDownloadNetworkError({
              message: `failed to download snippet: ${String(cause)}`,
            }),
        ),
      );
      yield* fetching?.clear() ?? Effect.void;

      // TS-only structured output. Expose the full payload so scripted callers
      // and agents can read snippet identity (`id`, `name`, `owner`, …)
      // alongside `content.sql`, matching the SIDE_EFFECTS.md contract and the
      // shape `snippets list --output-format json` uses for its response.
      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", asRecord(rawBody));
        return;
      }

      // Go's `download.Run` ignores `--output` entirely and always runs
      // `fmt.Println(resp.JSON200.Content.Sql)` (download.go:25). Mirror that:
      // no branching on `LegacyOutputFlag`.
      yield* output.raw(readSql(rawBody) + "\n");
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
