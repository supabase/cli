import { Duration, Effect } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import {
  LegacySsoMetadataUrlInvalidError,
  LegacySsoMetadataUrlNetworkError,
  LegacySsoMetadataUrlNonUtf8Error,
} from "./sso.errors.ts";
import { validateMetadataXmlBytes } from "./sso.saml.ts";

const METADATA_URL_TIMEOUT = Duration.seconds(10);

// Bound the body buffered into memory so a hostile or malformed metadata URL
// cannot exhaust the CLI process. 5 MiB is well above any plausible SAML 2.0
// IDP metadata document (real-world examples are typically 4–40 KiB).
const METADATA_URL_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Validates a SAML 2.0 metadata URL by issuing a 10-second GET with
 * `Accept: application/xml`, requiring HTTPS, refusing redirects, capping
 * the response body, and decoding it as strict UTF-8.
 *
 * Mirrors Go's `saml.ValidateMetadataURL`
 * (`apps/cli-go/internal/sso/internal/saml/files.go:62-93`) with two
 * defence-in-depth hardenings over the Go original:
 *   1. **No redirects** — the underlying `fetch` is configured with
 *      `redirect: "error"` so a 3xx hop from the user's HTTPS URL to
 *      `http://169.254.169.254/`, `http://10.x`, or other private/metadata
 *      endpoints cannot bypass the HTTPS guard.
 *   2. **Body size cap** — refuses to buffer more than 5 MiB so a
 *      malicious or buggy endpoint cannot OOM the CLI.
 *
 * Callers add their own ` Use --skip-url-validation to suppress this
 * error[.]` suffix — the trailing punctuation differs between Go's `create`
 * (no period) and `update` (period).
 */
export const validateMetadataUrl = (
  metadataUrl: string,
): Effect.Effect<
  void,
  | LegacySsoMetadataUrlInvalidError
  | LegacySsoMetadataUrlNetworkError
  | LegacySsoMetadataUrlNonUtf8Error,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => new URL(metadataUrl),
      catch: (cause) =>
        new LegacySsoMetadataUrlInvalidError({
          message: `failed to parse metadata uri: ${String(cause)}`,
        }),
    });

    // Go uses `strings.EqualFold(scheme, "https")`; URL.protocol is already
    // lowercased so direct compare is safe.
    if (parsed.protocol !== "https:") {
      return yield* Effect.fail(
        new LegacySsoMetadataUrlInvalidError({
          message: "only HTTPS Metadata URLs are supported",
        }),
      );
    }

    const httpClient = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(metadataUrl).pipe(
      HttpClientRequest.setHeader("Accept", "application/xml"),
    );

    const response = yield* httpClient.execute(request).pipe(
      // Refuse redirects so the HTTPS-only guard above can't be sidestepped via 3xx → http://internal/.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.timeout(METADATA_URL_TIMEOUT),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new LegacySsoMetadataUrlNetworkError({
            message: "failed to fetch metadata url: timeout",
          }),
        ),
      ),
      Effect.catchTag("HttpClientError", (cause) =>
        Effect.fail(
          new LegacySsoMetadataUrlNetworkError({
            message: `failed to fetch metadata url: ${String(cause)}`,
          }),
        ),
      ),
    );

    if (response.status !== 200) {
      return yield* Effect.fail(
        new LegacySsoMetadataUrlNetworkError({
          message: `unexpected metadata url status: ${response.status}`,
        }),
      );
    }

    const arrayBuffer = yield* response.arrayBuffer.pipe(
      Effect.mapError(
        (cause) =>
          new LegacySsoMetadataUrlNetworkError({
            message: `failed to read http response: ${String(cause)}`,
          }),
      ),
    );

    if (arrayBuffer.byteLength > METADATA_URL_MAX_BYTES) {
      return yield* Effect.fail(
        new LegacySsoMetadataUrlNetworkError({
          message: `metadata url response exceeds maximum allowed size (${METADATA_URL_MAX_BYTES} bytes)`,
        }),
      );
    }

    yield* validateMetadataXmlBytes(
      new Uint8Array(arrayBuffer),
      metadataUrl,
      (args) => new LegacySsoMetadataUrlNonUtf8Error({ message: args.message }),
    );
  });
