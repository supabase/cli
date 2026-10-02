import { Option, type Redacted } from "effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/**
 * Applies the Management API auth + identification headers to a raw `HttpClientRequest`:
 * an `Authorization: Bearer` header when a token is present, and the CLI `User-Agent`.
 *
 * Shared by commands that bypass the typed Management API client and issue raw HTTP
 * (e.g. `postgres-config`, `config push`'s cost-matrix fetch).
 */
export function requestWithAuth(
  request: HttpClientRequest.HttpClientRequest,
  tokenOpt: Option.Option<Redacted.Redacted<string>>,
  userAgent: string,
): HttpClientRequest.HttpClientRequest {
  return request.pipe(
    Option.isSome(tokenOpt) ? HttpClientRequest.bearerToken(tokenOpt.value) : (req) => req,
    HttpClientRequest.setHeader("User-Agent", userAgent),
  );
}
