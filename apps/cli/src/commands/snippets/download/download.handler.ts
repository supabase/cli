import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Predicate, Result, Schema } from "effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { goQuote } from "../../../command-internal/go-quote.ts";
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
 * folding is exact here: no non-ASCII rune case-folds to any rune of
 * "urn:uuid:", and multibyte runes can never byte-match an ASCII target.
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
        return Result.fail(`invalid urn prefix: ${goQuote(s.subarray(0, 9))}`);
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

const asRecord = (value: unknown): Record<string, unknown> =>
  Predicate.isObjectOrArray(value) ? { ...value } : {};

const decodeSnippet = Schema.decodeUnknownEffect(operationDefinitions.v1GetASnippet.outputSchema);

const mapDownloadError = mapHttpError({
  networkError: SnippetsDownloadNetworkError,
  statusError: SnippetsDownloadUnexpectedStatusError,
  networkMessage: (cause) => `failed to download snippet: ${cause}`,
  statusMessage: (status, body) => `unexpected download snippet status ${status}: ${body}`,
});

export const snippetsDownload = Effect.fn("snippets.download")(function* (
  flags: SnippetsDownloadFlags,
) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
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

      const fetching =
        output.format === "text" ? yield* output.task("Downloading snippet...") : undefined;
      // `executeRaw` keeps the response body intact so JSON output emits it as the API returned
      // it; the typed schema decodes a copy for the SQL.
      const response = yield* api
        .executeRaw(operationDefinitions.v1GetASnippet, { id: snippetId })
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.catch(mapDownloadError),
          Effect.tapError(() => fetching?.fail() ?? Effect.void),
        );
      const rawBody = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new SnippetsDownloadNetworkError({
              message: `failed to download snippet: ${String(cause)}`,
              decode: true,
            }),
        ),
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
      );
      const snippet = yield* decodeSnippet(rawBody).pipe(
        Effect.catch(mapDownloadError),
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
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
      const sql = snippet.content?.sql ?? "";
      yield* output.raw(sql + "\n");
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
