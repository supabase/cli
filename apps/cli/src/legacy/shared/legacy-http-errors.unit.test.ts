import { describe, expect, it } from "@effect/vitest";
import { SupabaseApiInputError } from "@supabase/api/effect";
import { Data, Effect } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
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
