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

const DASH_BYTE = 0x2d;

/**
 * `utf8.DecodeRune` semantics over a byte slice: returns the code point and
 * byte size at `i`, or `cp: -1` with `size: 1` for an invalid byte (invalid
 * lead, truncated/malformed continuation, overlong encoding, surrogate,
 * > U+10FFFF) — exactly the cases Go's `%q` renders as a lone `\xNN`.
 */
function decodeUtf8Rune(
  bytes: Uint8Array,
  i: number,
): { readonly cp: number; readonly size: number } {
  const b0 = bytes[i] ?? 0;
  if (b0 < 0x80) return { cp: b0, size: 1 };
  let extra: number;
  let cp: number;
  let min: number;
  if (b0 >= 0xc0 && b0 <= 0xdf) {
    extra = 1;
    cp = b0 & 0x1f;
    min = 0x80;
  } else if (b0 >= 0xe0 && b0 <= 0xef) {
    extra = 2;
    cp = b0 & 0x0f;
    min = 0x800;
  } else if (b0 >= 0xf0 && b0 <= 0xf7) {
    extra = 3;
    cp = b0 & 0x07;
    min = 0x10000;
  } else {
    return { cp: -1, size: 1 };
  }
  if (i + extra >= bytes.length) return { cp: -1, size: 1 };
  for (let k = 1; k <= extra; k++) {
    const b = bytes[i + k] ?? 0;
    if ((b & 0xc0) !== 0x80) return { cp: -1, size: 1 };
    cp = (cp << 6) | (b & 0x3f);
  }
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return { cp: -1, size: 1 };
  return { cp, size: extra + 1 };
}

// Go's `unicode.IsPrint` for runes ≥ 0x80: letters, marks, numbers,
// punctuation, symbols (the ASCII range is handled explicitly in goQuote).
// Unicode-table drift between the Go and JS engines is possible but only
// affects which escape a garbage rune gets in one error message.
const GO_PRINTABLE_RE = /[\p{L}\p{M}\p{N}\p{P}\p{S}]/u;

const GO_ESCAPES: Readonly<Record<number, string>> = {
  0x07: "\\a",
  0x08: "\\b",
  0x0c: "\\f",
  0x0a: "\\n",
  0x0d: "\\r",
  0x09: "\\t",
  0x0b: "\\v",
};

/**
 * Go `%q` (`strconv.Quote`) over the RAW UTF-8 bytes of the urn prefix, since
 * Go slices `s[:9]` by byte — a slice that can split a multibyte rune, which
 * `%q` then renders as `\xNN` per orphan byte (go1.26:
 * `%q` of `"12345678\xc3"` → `"12345678\xc3"`). Valid printable runes print
 * literally; control/non-printable ones use Go's `\a…\v` shorthands then
 * `\xNN` / `\uNNNN` / `\UNNNNNNNN`.
 */
function goQuote(bytes: Uint8Array): string {
  let out = '"';
  for (let i = 0; i < bytes.length;) {
    const { cp, size } = decodeUtf8Rune(bytes, i);
    if (cp === -1) {
      out += `\\x${(bytes[i] ?? 0).toString(16).padStart(2, "0")}`;
      i += 1;
      continue;
    }
    i += size;
    const escape = GO_ESCAPES[cp];
    const ch = String.fromCodePoint(cp);
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (escape !== undefined) out += escape;
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (cp < 0x80) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (GO_PRINTABLE_RE.test(ch)) out += ch;
    else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return `${out}"`;
}

function canonicalFromHex(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

/**
 * Reads `[start, end)` of `s` as lowercase hex, or `undefined` on the first
 * non-hex byte — the byte-wise equivalent of Go's `xtob` loop.
 */
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
 * `strings.EqualFold(s[:9], "urn:uuid:")` equivalent. ASCII-only folding over
 * the raw bytes is exact here: no non-ASCII rune case-folds to any rune of
 * `"urn:uuid:"` (Unicode's only ASCII-target simple folds are `ſ`→`s` and
 * `K`→`k`, neither of which appears), and multibyte runes can never
 * byte-match an ASCII target.
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
 * Everything operates on the argument's UTF-8 BYTES: Go's `switch len(s)`
 * counts bytes where a JS string's `length` counts UTF-16 code units, so a
 * non-ASCII argument like `é<canonical-uuid>}` (JS length 38, 39 bytes) must
 * take Go's default branch and report `invalid UUID length: 39` — not slip
 * into the braced branch and issue a request (verified against go1.26 +
 * google/uuid v1.6.0).
 *
 * This pre-check is load-bearing for error-message parity: the generated
 * `V1GetASnippetInput` schema already pattern-checks UUIDs, so without it a
 * non-UUID input would surface as a `SchemaError` with a `failed to download
 * snippet:` prefix instead of Go's `invalid snippet ID:`.
 */
export function legacyParseSnippetUuid(
  input: string,
): { readonly canonical: string } | { readonly error: string } {
  let s = new TextEncoder().encode(input);
  switch (s.length) {
    // xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    case 36:
      break;
    // urn:uuid:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    case 45: {
      if (!isUrnUuidPrefix(s)) {
        return { error: `invalid urn prefix: ${goQuote(s.subarray(0, 9))}` };
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
      if (hex === undefined) return { error: "invalid UUID format" };
      return { canonical: canonicalFromHex(hex) };
    }
    default:
      return { error: `invalid UUID length: ${s.length}` };
  }
  // s is now at least 36 bytes and must be xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.
  if (s[8] !== DASH_BYTE || s[13] !== DASH_BYTE || s[18] !== DASH_BYTE || s[23] !== DASH_BYTE) {
    return { error: "invalid UUID format" };
  }
  const segments = [
    readHexRange(s, 0, 8),
    readHexRange(s, 9, 13),
    readHexRange(s, 14, 18),
    readHexRange(s, 19, 23),
    readHexRange(s, 24, 36),
  ];
  if (segments.some((segment) => segment === undefined)) {
    return { error: "invalid UUID format" };
  }
  return { canonical: canonicalFromHex(segments.join("")) };
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
