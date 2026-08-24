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
 * Internal discriminated failure for the CNAME verification pipeline:
 * `transport: true` for resolver failures (fetch error, non-200, timeout),
 * `transport: false` for a genuine finding about the user's DNS records
 * (no CNAME answer). Consumed exclusively by {@link verifyLegacyCname}, which
 * folds it into `LegacyDomainsCnameError` so telemetry can tell a Cloudflare
 * DoH outage apart from a misconfigured record.
 */
export interface LegacyCnameFailure {
  readonly transport: boolean;
  readonly detail: string;
}

/**
 * Extract the first CNAME answer's `data` from a Cloudflare DNS-over-HTTPS JSON
 * response. Mirrors `utils.ResolveCNAME`
 * (`apps/cli-go/internal/utils/api.go:60-79`): scan `Answer` for the first entry
 * with `type === 5` and return its `data`; otherwise fail with the
 * established "failed to locate" wording, embedding a capped, readable JSON
 * dump of the answers instead of the reference implementation's actual
 * (uncapped, `%+v`-on-`[]byte`) dump — see the NOTE at the failure site below
 * for why those don't byte-match.
 */
export function parseFirstCname(
  payload: unknown,
  host: string,
): Effect.Effect<string, LegacyCnameFailure> {
  const answers = isRecord(payload) && Array.isArray(payload["Answer"]) ? payload["Answer"] : [];
  for (const answer of answers) {
    if (isRecord(answer) && answer["type"] === CNAME_TYPE && typeof answer["data"] === "string") {
      return Effect.succeed(answer["data"]);
    }
  }
  // Cap the embedded answer dump (mirrors the 1024-byte policy in
  // `sanitizeLegacyErrorBody`) so an oversized DNS response can't flood the
  // error envelope. Both the cap and the readable-JSON format are deliberate
  // TS divergences: `ResolveCNAME` (`apps/cli-go/internal/utils/api.go:73-78`)
  // JSON-marshals the answers to a `[]byte`, then formats that `[]byte` with
  // `%+v` — a `%+v`-on-`[]byte` footgun that Go's `fmt` renders as an
  // uncapped decimal byte-value array (e.g. `[91 10 32 32 ...]` — `91` is the
  // `[` that opens the marshaled JSON array, not the JSON text itself;
  // empirically verified by compiling Go).
  const dump = JSON.stringify(answers, null, 4);
  const capped = dump.length > 1024 ? `${dump.slice(0, 1024)}…` : dump;
  return Effect.fail({
    transport: false,
    detail: `failed to locate appropriate CNAME record for ${host}; resolves to ${capped}`,
  });
}

/**
 * Render the `%w`-wrapped cause string for the "failed to resolve" CNAME error.
 * Transport / timeout / parse failures all flow through here so the outer
 * message stays consistently shaped without leaking object internals.
 */
export function formatCnameCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (isRecord(cause) && typeof cause["message"] === "string") return cause["message"];
  return String(cause);
}

const transportFailure = (cause: unknown): LegacyCnameFailure => ({
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
    const response = yield* args.httpClient
      .execute(request)
      .pipe(Effect.mapError(transportFailure));
    if (response.status !== 200) {
      return yield* Effect.fail<LegacyCnameFailure>({
        transport: true,
        detail: `unexpected DNS query status ${response.status}`,
      });
    }
    const payload = yield* response.json.pipe(Effect.mapError(transportFailure));
    return yield* parseFirstCname(payload, args.customHostname);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) => {
      const failure: LegacyCnameFailure =
        typeof cause === "object" && cause !== null && "transport" in cause
          ? cause
          : transportFailure(cause);
      return new LegacyDomainsCnameError({
        message: `expected custom hostname '${args.customHostname}' to have a CNAME record pointing to your project at '${expected}', but it failed to resolve: ${failure.detail}`,
        transport: failure.transport,
      });
    }),
  );

  if (resolved !== expected) {
    return yield* new LegacyDomainsCnameError({
      message: `expected custom hostname '${args.customHostname}' to have a CNAME record pointing to your project at '${expected}', but it is currently set to '${resolved}'`,
    });
  }
});
