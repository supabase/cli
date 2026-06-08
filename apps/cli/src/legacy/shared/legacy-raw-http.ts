import { Option, type Redacted } from "effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/**
 * Applies the Management API auth + identification headers to a raw
 * `HttpClientRequest`: an `Authorization: Bearer` header when a token is
 * present, and the CLI `User-Agent`.
 *
 * Shared by the legacy commands that bypass the typed Management API client and
 * issue raw HTTP (e.g. `postgres-config` arbitrary key/value updates,
 * `config push` cost-matrix fetch) so the bearer/User-Agent wiring lives in one
 * place instead of being copy-pasted per command.
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
