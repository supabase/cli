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

const HEX_32_RE = /^[0-9a-fA-F]{32}$/;

/** Minimal Go `%q` for the urn-prefix error — CLI args are ASCII in practice. */
function goQuote(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (code >= 0x20 && code < 0x7f) out += ch;
    else out += `\\x${code.toString(16).padStart(2, "0")}`;
  }
  return `${out}"`;
}

function canonicalFromHex(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

/**
 * Faithful port of Go's `uuid.Parse` (google/uuid v1.6.0, `uuid.go:68-117`),
 * which `download.Run` uses to validate the snippet id
 * (`apps/cli-go/internal/snippets/download/download.go:15-17`). Accepts the
 * same 4 forms Go does — hyphenated (36), `urn:uuid:`-prefixed (45), braced
 * `{…}` (38, where only the middle 36 bytes are examined — the trailing byte
 * is never validated, mirroring `s = s[1:]`), and raw 32-hex — and returns
 * the CANONICAL lowercase hyphenated form (Go interpolates the parsed
 * `uuid.UUID`, whose `String()` is always lowercase, into the request URL —
 * never the raw arg). Error strings reproduce Go's three branches verbatim;
 * the caller wraps them like `fmt.Errorf("invalid snippet ID: %w", err)`.
 *
 * This pre-check is load-bearing for error-message parity: the generated
 * `V1GetASnippetInput` schema already pattern-checks UUIDs, so without it a
 * non-UUID input would surface as a `SchemaError` with a `failed to download
 * snippet:` prefix instead of Go's `invalid snippet ID:`.
 */
export function legacyParseSnippetUuid(
  input: string,
): { readonly canonical: string } | { readonly error: string } {
  let s = input;
  switch (s.length) {
    // xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    case 36:
      break;
    // urn:uuid:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    case 45: {
      if (s.slice(0, 9).toLowerCase() !== "urn:uuid:") {
        return { error: `invalid urn prefix: ${goQuote(s.slice(0, 9))}` };
      }
      s = s.slice(9);
      break;
    }
    // {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}
    case 38:
      s = s.slice(1);
      break;
    // xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    case 32: {
      if (!HEX_32_RE.test(s)) return { error: "invalid UUID format" };
      return { canonical: canonicalFromHex(s.toLowerCase()) };
    }
    default:
      return { error: `invalid UUID length: ${input.length}` };
  }
  // s is now at least 36 chars and must be xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.
  if (s[8] !== "-" || s[13] !== "-" || s[18] !== "-" || s[23] !== "-") {
    return { error: "invalid UUID format" };
  }
  const hex = s.slice(0, 8) + s.slice(9, 13) + s.slice(14, 18) + s.slice(19, 23) + s.slice(24, 36);
  if (!HEX_32_RE.test(hex)) return { error: "invalid UUID format" };
  return { canonical: canonicalFromHex(hex.toLowerCase()) };
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
      const parsed = legacyParseSnippetUuid(flags.snippetId);
      if ("error" in parsed) {
        return yield* new LegacySnippetsInvalidIdError({
          message: `invalid snippet ID: ${parsed.error}`,
        });
      }

      const tokenOpt = yield* resolveLegacyAccessToken;
      const authHeader: (
        req: HttpClientRequest.HttpClientRequest,
      ) => HttpClientRequest.HttpClientRequest = Option.isSome(tokenOpt)
        ? HttpClientRequest.bearerToken(tokenOpt.value)
        : (req) => req;
      const request = HttpClientRequest.get(
        `${cliConfig.apiUrl}/v1/snippets/${parsed.canonical}`,
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
