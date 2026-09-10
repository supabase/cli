import { Effect } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { DomainsCnameError } from "./domains.errors.ts";

// Cloudflare DNS-over-HTTPS record type for CNAME (IANA DNS parameter 5).
const CNAME_TYPE = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Discriminated CNAME verification failure: `transport: true` for resolver
 * failures (fetch error, non-200, timeout), `transport: false` for a genuine
 * finding about the user's DNS records (no CNAME answer).
 */
export interface CnameFailure {
  readonly transport: boolean;
  readonly detail: string;
}

/**
 * Extracts the first CNAME answer's `data` from a Cloudflare DNS-over-HTTPS
 * JSON response, or fails with a "failed to locate" message embedding a
 * capped JSON dump of the answers.
 */
export function parseFirstCname(
  payload: unknown,
  host: string,
): Effect.Effect<string, CnameFailure> {
  const answers = isRecord(payload) && Array.isArray(payload["Answer"]) ? payload["Answer"] : [];
  for (const answer of answers) {
    if (isRecord(answer) && answer["type"] === CNAME_TYPE && typeof answer["data"] === "string") {
      return Effect.succeed(answer["data"]);
    }
  }
  // Cap the embedded answer dump so an oversized DNS response can't flood the error envelope.
  const dump = JSON.stringify(answers, null, 4);
  const capped = dump.length > 1024 ? `${dump.slice(0, 1024)}…` : dump;
  return Effect.fail({
    transport: false,
    detail: `failed to locate appropriate CNAME record for ${host}; resolves to ${capped}`,
  });
}

/** Formats a failure cause as a plain string, without leaking object internals. */
export function formatCnameCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (isRecord(cause) && typeof cause["message"] === "string") return cause["message"];
  return String(cause);
}

const transportFailure = (cause: unknown): CnameFailure => ({
  transport: true,
  detail: formatCnameCause(cause),
});

/**
 * Verify that `customHostname` has a CNAME record pointing at the project's
 * Supabase subdomain before initializing a custom hostname. Queries
 * `https://1.1.1.1/dns-query` (DNS-over-HTTPS, `accept: application/dns-json`,
 * 10s timeout) and compares the resolved CNAME to `<ref>.<projectHost>.`.
 *
 * The `HttpClient` is passed in (not yielded) so this helper carries no service
 * requirement and composes cleanly into the create handler.
 */
export const verifyCname = Effect.fnUntraced(function* (args: {
  readonly httpClient: HttpClient.HttpClient;
  readonly projectHost: string;
  readonly ref: string;
  readonly customHostname: string;
}) {
  const expected = `${args.ref}.${args.projectHost}.`;
  const url = `https://1.1.1.1/dns-query?name=${encodeURIComponent(args.customHostname)}&type=${CNAME_TYPE}`;
  const request = HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader("accept", "application/dns-json"),
  );

  const resolved = yield* Effect.gen(function* () {
    const response = yield* args.httpClient
      .execute(request)
      .pipe(Effect.mapError(transportFailure));
    if (response.status !== 200) {
      return yield* Effect.fail<CnameFailure>({
        transport: true,
        detail: `unexpected DNS query status ${response.status}`,
      });
    }
    const payload = yield* response.json.pipe(Effect.mapError(transportFailure));
    return yield* parseFirstCname(payload, args.customHostname);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) => {
      const failure: CnameFailure =
        typeof cause === "object" && cause !== null && "transport" in cause
          ? cause
          : transportFailure(cause);
      return new DomainsCnameError({
        message: `expected custom hostname '${args.customHostname}' to have a CNAME record pointing to your project at '${expected}', but it failed to resolve: ${failure.detail}`,
        transport: failure.transport,
      });
    }),
  );

  if (resolved !== expected) {
    return yield* Effect.fail(
      new DomainsCnameError({
        message: `expected custom hostname '${args.customHostname}' to have a CNAME record pointing to your project at '${expected}', but it is currently set to '${resolved}'`,
      }),
    );
  }
});
