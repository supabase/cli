import { describe, expect, it } from "@effect/vitest";
import { SupabaseApiInputError } from "@supabase/api/effect";
import { Data, Effect, Exit, Option } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { mockAnalytics } from "../../../tests/helpers/mocks.ts";
import {
  legacyStatusCodeFailure,
  legacyTransportFailure,
} from "../../../tests/helpers/legacy-mocks.ts";
import { errorEntitlement } from "../../shared/api/plan-gate.ts";
import { classifyCliErrorActionability } from "../../shared/telemetry/error-actionability.ts";
import { mapLegacyHttpError } from "./legacy-http-errors.ts";

class TestNetworkError extends Data.TaggedError("TestNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {}

class TestStatusError extends Data.TaggedError("TestStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

const mapError = mapLegacyHttpError({
  networkError: TestNetworkError,
  statusError: TestStatusError,
  networkMessage: (cause) => cause,
  statusMessage: (status, body) => `${status}: ${body}`,
});

const mapTestError = mapLegacyHttpError({
  networkError: TestNetworkError,
  statusError: TestStatusError,
  networkMessage: (cause) => `network: ${cause}`,
  statusMessage: (status, body) => `status ${status}: ${body}`,
});

const ENVELOPE_BODY = {
  message: "gated",
  error: {
    code: "entitlement_required",
    feature: "custom_domain",
    upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
  },
};

function failedError(exit: Exit.Exit<never, unknown>): unknown {
  return Option.getOrUndefined(Exit.findErrorOption(exit));
}

describe("mapLegacyHttpError", () => {
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
    }).pipe(Effect.provide(mockAnalytics().layer)),
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
    }).pipe(Effect.provide(mockAnalytics().layer)),
  );

  it.effect("attaches the parsed entitlement on an envelope body", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(mapTestError(legacyStatusCodeFailure(403, ENVELOPE_BODY)));
      const error = failedError(exit);
      expect(errorEntitlement(error)).toEqual({
        feature: "custom_domain",
        upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
      });
      expect((error as TestStatusError).body).toContain("entitlement_required");
    }).pipe(Effect.provide(mockAnalytics().layer)),
  );

  it.effect("fires cli_upgrade_suggested once per envelope denial", () => {
    const analytics = mockAnalytics();
    return Effect.gen(function* () {
      yield* Effect.exit(mapTestError(legacyStatusCodeFailure(403, ENVELOPE_BODY)));
      expect(analytics.captured).toEqual([
        {
          event: "cli_upgrade_suggested",
          properties: { feature_key: "custom_domain", org_slug: "env-org" },
        },
      ]);
    }).pipe(Effect.provide(analytics.layer));
  });

  it.effect("suppresses the event but keeps the fields with trackUpgradeSuggested=false", () => {
    const analytics = mockAnalytics();
    const mapUntracked = mapLegacyHttpError({
      networkError: TestNetworkError,
      statusError: TestStatusError,
      networkMessage: (cause) => `network: ${cause}`,
      statusMessage: (status, body) => `status ${status}: ${body}`,
      trackUpgradeSuggested: false,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(mapUntracked(legacyStatusCodeFailure(403, ENVELOPE_BODY)));
      expect(analytics.captured).toEqual([]);
      expect(errorEntitlement(failedError(exit))).toEqual({
        feature: "custom_domain",
        upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
      });
    }).pipe(Effect.provide(analytics.layer));
  });

  it.effect("fires no event without an envelope", () => {
    const analytics = mockAnalytics();
    return Effect.gen(function* () {
      yield* Effect.exit(mapTestError(legacyStatusCodeFailure(403, { message: "denied" })));
      expect(analytics.captured).toEqual([]);
    }).pipe(Effect.provide(analytics.layer));
  });

  it.effect("parses the envelope from the raw body before truncation", () =>
    Effect.gen(function* () {
      const padded = { ...ENVELOPE_BODY, message: "x".repeat(1500) };
      const exit = yield* Effect.exit(mapTestError(legacyStatusCodeFailure(403, padded)));
      const error = failedError(exit);
      expect(errorEntitlement(error)).toEqual({
        feature: "custom_domain",
        upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
      });
      expect((error as TestStatusError).body.length).toBe(1024);
    }).pipe(Effect.provide(mockAnalytics().layer)),
  );

  it.effect("attaches nothing on a plain 4xx body", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        mapTestError(legacyStatusCodeFailure(403, { message: "denied" })),
      );
      const error = failedError(exit);
      expect(errorEntitlement(error)).toBeUndefined();
      expect(Object.hasOwn(error as object, "entitlement")).toBe(false);
    }).pipe(Effect.provide(mockAnalytics().layer)),
  );

  it.effect("maps transport failures to the network error unchanged", () =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get("https://api.supabase.com/v1/projects/x");
      const exit = yield* Effect.exit(mapTestError(legacyTransportFailure(request)));
      const error = failedError(exit);
      expect(error).toBeInstanceOf(TestNetworkError);
      expect((error as TestNetworkError).message).toBe("network: ECONNREFUSED");
    }).pipe(Effect.provide(mockAnalytics().layer)),
  );
});
