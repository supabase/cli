import { Effect } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyDomainsCnameError } from "./domains.errors.ts";

// Cloudflare DNS-over-HTTPS record type for CNAME (IANA DNS parameter 5).
const CNAME_TYPE = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract the first CNAME answer's `data` from a Cloudflare DNS-over-HTTPS JSON
 * response. Mirrors Go's `utils.ResolveCNAME`
 * (`apps/cli-go/internal/utils/api.go:60-79`): scan `Answer` for the first entry
 * with `type === 5` and return its `data`; otherwise fail with the same
 * "failed to locate" message Go embeds (4-space-indented JSON of the answers).
 */
export function parseFirstCname(payload: unknown, host: string): Effect.Effect<string, Error> {
  const answers = isRecord(payload) && Array.isArray(payload["Answer"]) ? payload["Answer"] : [];
  for (const answer of answers) {
    if (isRecord(answer) && answer["type"] === CNAME_TYPE && typeof answer["data"] === "string") {
      return Effect.succeed(answer["data"]);
    }
  }
  // Cap the embedded answer dump so an oversized DNS response can't flood the
  // error envelope (mirrors the 1024-byte policy in `sanitizeLegacyErrorBody`).
  const dump = JSON.stringify(answers, null, 4);
  const capped = dump.length > 1024 ? `${dump.slice(0, 1024)}…` : dump;
  return Effect.fail(
    new Error(`failed to locate appropriate CNAME record for ${host}; resolves to ${capped}`),
  );
}

/**
 * Render the `%w`-wrapped cause string for the "failed to resolve" CNAME error.
 * Transport / timeout / parse failures and the locate error all flow through
 * here so the outer message stays Go-shaped without leaking object internals.
 */
export function formatCnameCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (isRecord(cause) && typeof cause["message"] === "string") return cause["message"];
  return String(cause);
}

/**
 * Verify that `customHostname` has a CNAME record pointing at the project's
 * Supabase subdomain before initializing a custom hostname. Mirrors
 * `apps/cli-go/internal/hostnames/common.go:14-22` + `cloudflare/api.go`:
 * queries `https://1.1.1.1/dns-query` (DNS-over-HTTPS, `accept: application/dns-json`,
 * 10s timeout) and compares the resolved CNAME to `<ref>.<projectHost>.`.
 *
 * The `HttpClient` is passed in (not yielded) so this helper carries no service
 * requirement and composes cleanly into the create handler.
 */
export const verifyLegacyCname = Effect.fnUntraced(function* (args: {
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
    const response = yield* args.httpClient.execute(request);
    if (response.status !== 200) {
      return yield* Effect.fail(new Error(`unexpected DNS query status ${response.status}`));
    }
    const payload = yield* response.json;
    return yield* parseFirstCname(payload, args.customHostname);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError(
      (cause) =>
        new LegacyDomainsCnameError({
          message: `expected custom hostname '${args.customHostname}' to have a CNAME record pointing to your project at '${expected}', but it failed to resolve: ${formatCnameCause(cause)}`,
        }),
    ),
  );

  if (resolved !== expected) {
    return yield* Effect.fail(
      new LegacyDomainsCnameError({
        message: `expected custom hostname '${args.customHostname}' to have a CNAME record pointing to your project at '${expected}', but it is currently set to '${resolved}'`,
      }),
    );
  }
});
