import { Effect, Option, Predicate, Result, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { resolveAccessToken } from "../../../command-internal/resolve-token.ts";
import { requestWithAuth } from "../../../command-internal/raw-http.ts";
import { sanitizeErrorBody } from "../../../command-internal/http-errors.ts";
import { quoteBytes } from "../../../command-internal/byte-quote.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  SnippetsDownloadNetworkError,
  SnippetsDownloadUnexpectedStatusError,
  SnippetsInvalidIdError,
} from "../snippets.errors.ts";
import type { SnippetsDownloadFlags } from "./download.command.ts";

const DASH_BYTE = 0x2d;

function canonicalFromHex(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

/** Reads `[start, end)` of `s` as lowercase hex, or `undefined` on the first non-hex byte. */
function readHexRange(s: Uint8Array, start: number, end: number): string | undefined {
  let out = "";
  for (let i = start; i < end; i++) {
    const b = s[i] ?? 0;
    if (b >= 0x30 && b <= 0x39) {
      out += String.fromCharCode(b);
    } else {
      const lower = b | 0x20;
      if (lower < 0x61 || lower > 0x66) return undefined;
      out += String.fromCharCode(lower);
    }
  }
  return out;
}

/**
 * Case-insensitive match against "urn:uuid:" over raw bytes. ASCII-only
 * folding is exact here: no non-ASCII character case-folds to any character of
 * "urn:uuid:", and multibyte characters can never byte-match an ASCII target.
 */
function isUrnUuidPrefix(bytes: Uint8Array): boolean {
  const expected = "urn:uuid:";
  for (let i = 0; i < expected.length; i++) {
    const b = bytes[i] ?? 0;
    const lower = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
    if (lower !== expected.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Validates a snippet id before it reaches the Management API, accepting the
 * 4 forms handled below and always returning the canonical lowercase
 * hyphenated form. Operates on UTF-8 bytes, not UTF-16 code units, so
 * non-ASCII input is measured by byte length — this pre-check is load-bearing,
 * since the generated schema would otherwise report a generic `SchemaError`.
 */
export function parseSnippetUuid(input: string): Result.Result<string, string> {
  let s = new TextEncoder().encode(input);
  switch (s.length) {
    // xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    case 36:
      break;
    // urn:uuid:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    case 45: {
      if (!isUrnUuidPrefix(s)) {
        return Result.fail(`invalid urn prefix: ${quoteBytes(s.subarray(0, 9))}`);
      }
      s = s.subarray(9);
      break;
    }
    // {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}
    case 38:
      s = s.subarray(1);
      break;
    // xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    case 32: {
      const hex = readHexRange(s, 0, 32);
      if (hex === undefined) return Result.fail("invalid UUID format");
      return Result.succeed(canonicalFromHex(hex));
    }
    default:
      return Result.fail(`invalid UUID length: ${s.length}`);
  }
  // s is now at least 36 bytes and must be xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.
  if (s[8] !== DASH_BYTE || s[13] !== DASH_BYTE || s[18] !== DASH_BYTE || s[23] !== DASH_BYTE) {
    return Result.fail("invalid UUID format");
  }
  const segments = [
    readHexRange(s, 0, 8),
    readHexRange(s, 9, 13),
    readHexRange(s, 14, 18),
    readHexRange(s, 19, 23),
    readHexRange(s, 24, 36),
  ];
  if (segments.some((segment) => segment === undefined)) {
    return Result.fail("invalid UUID format");
  }
  return Result.succeed(canonicalFromHex(segments.join("")));
}

// Tolerant body parse — see `list.handler.ts` for the rationale. The real
// `/v1/snippets/{id}` payload omits `description`, which the generated schema
// requires, so routing through the typed client fails on real responses.
function asRecord(obj: unknown): Record<string, unknown> {
  return Predicate.isObjectOrArray(obj) ? { ...obj } : {};
}

const decodeSnippetSql = Schema.decodeUnknownOption(
  Schema.Struct({ content: Schema.Struct({ sql: Schema.String }) }),
);

export const snippetsDownload = Effect.fn("snippets.download")(function* (
  flags: SnippetsDownloadFlags,
) {
  const output = yield* Output;
  const httpClient = yield* HttpClient.HttpClient;
  const cliSettings = yield* CommandSettings;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const snippetId = yield* Effect.fromResult(parseSnippetUuid(flags.snippetId)).pipe(
        Effect.mapError(
          (error) => new SnippetsInvalidIdError({ message: `invalid snippet ID: ${error}` }),
        ),
      );

      const tokenOpt = yield* resolveAccessToken;
      const request = requestWithAuth(
        HttpClientRequest.get(`${cliSettings.apiUrl}/v1/snippets/${snippetId}`),
        tokenOpt,
        cliSettings.userAgent,
      );

      const fetching =
        output.format === "text" ? yield* output.task("Downloading snippet...") : undefined;
      const response = yield* httpClient.execute(request).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.mapError(
          (cause) =>
            new SnippetsDownloadNetworkError({
              message: `failed to download snippet: ${cause.reason.description ?? cause.reason._tag}`,
            }),
        ),
      );

      if (response.status !== 200) {
        yield* fetching?.fail() ?? Effect.void;
        const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        const body = sanitizeErrorBody(rawBody);
        return yield* new SnippetsDownloadUnexpectedStatusError({
          status: response.status,
          body,
          message: `unexpected download snippet status ${response.status}: ${body}`,
        });
      }

      const rawBody = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new SnippetsDownloadNetworkError({
              message: `failed to download snippet: ${String(cause)}`,
              // 200-response body decode failure — an API-response problem, not
              // a transport/network failure.
              decode: true,
            }),
        ),
      );
      yield* fetching?.clear ?? Effect.void;

      // Exposes the full payload (id, name, owner, ... alongside content.sql)
      // for scripted callers — see SIDE_EFFECTS.md; matches the shape
      // `snippets list --output-format json` uses.
      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", asRecord(rawBody));
        return;
      }

      // `-o`/`--output` is ignored entirely; this always prints the raw SQL —
      // no branching on `OutputFlag`.
      const sql = Option.match(decodeSnippetSql(rawBody), {
        onNone: () => "",
        onSome: ({ content }) => content.sql,
      });
      yield* output.raw(sql + "\n");
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
