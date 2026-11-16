import { describe, expect, it } from "@effect/vitest";
import { SupabaseApiInputError } from "@supabase/api/effect";
import { Data, Effect } from "effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { classifyCliErrorActionability } from "../shared/telemetry/error-actionability.ts";

import { sanitizeInlineName, mapHttpError, unexpectedStatusMessage } from "./http-errors.ts";

class TestNetworkError extends Data.TaggedError("TestNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {}

class TestStatusError extends Data.TaggedError("TestStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

const mapError = mapHttpError({
  networkError: TestNetworkError,
  statusError: TestStatusError,
  networkMessage: (cause) => cause,
  statusMessage: (status, body) => `${status}: ${body}`,
});

describe("mapHttpError", () => {
  it.effect("preserves generated API input errors", () =>
    Effect.gen(function* () {
      const inputError = new SupabaseApiInputError("invalid request input");

      const error = yield* mapError(inputError).pipe(Effect.flip);

      expect(error).toBe(inputError);
      expect(inputError.source).toBe("generated_client");
      expect(classifyCliErrorActionability(error)).toMatchObject({
        error_kind: "internal_bug",
        error_category: "impossible_state",
        error_fingerprint: "tag:SupabaseApiInputError:request_encoding",
      });
    }),
  );

  it.effect("preserves request-body construction errors", () =>
    Effect.gen(function* () {
      const bodyError = new HttpBody.HttpBodyError({
        reason: { _tag: "JsonError" },
        cause: new Error("body read failed"),
      });

      const error = yield* mapError(bodyError).pipe(Effect.flip);

      expect(error).toBe(bodyError);
      expect(classifyCliErrorActionability(error)).toMatchObject({
        error_kind: "internal_bug",
        error_category: "impossible_state",
        error_fingerprint: "tag:HttpBodyError:request_encoding",
      });
    }),
  );
});

const UPGRADE_URL = "https://supabase.com/dashboard/org/acme/billing";

function statusFailure(status: number, body: string): HttpClientError.HttpClientError {
  const request = HttpClientRequest.get("https://api.supabase.com/v1/projects/test/backups");
  const response = HttpClientResponse.fromWeb(request, new Response(body, { status }));
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({ request, response }),
  });
}

function planGateBody(error: Record<string, unknown>, message = "Upgrade required"): string {
  return JSON.stringify({ message, error: { code: "entitlement_required", ...error } });
}

describe("mapHttpError plan-gate entitlement", () => {
  it.effect("attaches the entitlement from a gated body longer than the embedded body cap", () =>
    Effect.gen(function* () {
      const body = planGateBody({ feature: "backups", upgrade_url: UPGRADE_URL }, "x".repeat(2000));

      const error = yield* mapError(statusFailure(402, body)).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "TestStatusError",
        status: 402,
        entitlement: { feature: "backups", upgrade_url: UPGRADE_URL },
      });
    }),
  );

  it.effect.each(["", "<html>Bad Gateway</html>", '{"message":"Not Found"}'])(
    "keeps the plain status error for a non-envelope 4xx body %j",
    (body) =>
      Effect.gen(function* () {
        const error = yield* mapError(statusFailure(403, body)).pipe(Effect.flip);

        expect(error).toMatchObject({ _tag: "TestStatusError", status: 403, body });
        expect(error).not.toHaveProperty("entitlement");
      }),
  );

  it.effect("ignores a plan-gate body on a 5xx", () =>
    Effect.gen(function* () {
      const body = planGateBody({ feature: "backups", upgrade_url: UPGRADE_URL });

      const error = yield* mapError(statusFailure(503, body)).pipe(Effect.flip);

      expect(error).not.toHaveProperty("entitlement");
    }),
  );

  it.effect.each([
    { case: "a non-web upgrade_url", feature: "backups", upgradeUrl: "javascript:alert(1)" },
    {
      case: "an upgrade_url carrying credentials",
      feature: "backups",
      upgradeUrl: "https://supabase.com@evil.example/billing",
    },
    {
      case: "a feature carrying a bidi override",
      feature: `backups${String.fromCodePoint(0x202e)}`,
      upgradeUrl: UPGRADE_URL,
    },
  ])("drops the entitlement for $case", ({ feature, upgradeUrl }) =>
    Effect.gen(function* () {
      const body = planGateBody({ feature, upgrade_url: upgradeUrl });

      const error = yield* mapError(statusFailure(402, body)).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "TestStatusError", status: 402 });
      expect(error).not.toHaveProperty("entitlement");
    }),
  );

  it.effect("percent-encodes control and bidi characters in the upgrade_url", () =>
    Effect.gen(function* () {
      const rlo = String.fromCodePoint(0x202e);
      const csi = String.fromCodePoint(0x9b);
      const body = planGateBody({
        feature: "backups",
        upgrade_url: `${UPGRADE_URL}?ref=${rlo}${csi}`,
      });

      const error = yield* mapError(statusFailure(402, body)).pipe(Effect.flip);

      expect(error).toMatchObject({
        entitlement: { feature: "backups", upgrade_url: `${UPGRADE_URL}?ref=%E2%80%AE%C2%9B` },
      });
    }),
  );
});

describe("unexpectedStatusMessage", () => {
  it("shapes the generic unexpected-status message", () => {
    expect(unexpectedStatusMessage(500, '{"message":"boom"}')).toBe(
      'unexpected status 500: {"message":"boom"}',
    );
  });
});

describe("sanitizeInlineName", () => {
  it("strips a right-to-left override so a path segment survives without the control char", () => {
    // U+202E (RLO) can visually reorder everything after it in a terminal/log
    // line — e.g. disguising a malicious path segment as something benign.
    const rlo = String.fromCodePoint(0x202e);
    const sanitized = sanitizeInlineName(`evil${rlo}name`);
    expect(sanitized).not.toContain(rlo);
    expect(sanitized).toBe("evilname");
  });

  it("strips other bidi controls (LRM/RLM, embeddings, isolates)", () => {
    const controls = [0x200e, 0x200f, 0x202a, 0x202b, 0x2066, 0x2069].map((code) =>
      String.fromCodePoint(code),
    );
    const hostile = ["a", "b", "c", "d", "e", "f"]
      .map((letter, index) => `${letter}${controls[index]}`)
      .join("");
    const sanitized = sanitizeInlineName(hostile);
    expect(sanitized).toBe("abcdef");
  });

  it("strips C1 controls, including U+009B (CSI on some terminals)", () => {
    // Equivalent to the ESC `[` sequence the ASCII control strip already
    // guards against, just reachable via a single C1 code point.
    const csi = String.fromCodePoint(0x9b);
    const sanitized = sanitizeInlineName(`evil${csi}[31mname`);
    expect(sanitized).not.toContain(csi);
    expect(sanitized).toBe("evil[31mname");
  });

  it("strips unicode line separators, which can fracture single-line output like \\n does", () => {
    const lineSep = String.fromCodePoint(0x2028);
    const paraSep = String.fromCodePoint(0x2029);
    const sanitized = sanitizeInlineName(`first${lineSep}second${paraSep}third`);
    expect(sanitized).not.toContain(lineSep);
    expect(sanitized).not.toContain(paraSep);
    expect(sanitized).toBe("firstsecondthird");
  });
});
