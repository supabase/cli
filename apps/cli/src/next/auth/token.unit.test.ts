import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { InvalidTokenError } from "./errors.ts";
import { validateToken } from "./token.ts";

const VALID_HEX_40 = "a".repeat(40);

function expectInvalidTokenError(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true);
  const errorOption = Exit.findErrorOption(exit);
  expect(Option.isSome(errorOption)).toBe(true);
  if (Option.isSome(errorOption)) {
    expect(errorOption.value).toBeInstanceOf(InvalidTokenError);
  }
}

describe("validateToken", () => {
  describe("valid tokens", () => {
    it.live("accepts sbp_ prefix with 40 lowercase hex chars", () =>
      Effect.gen(function* () {
        yield* validateToken(`sbp_${VALID_HEX_40}`);
      }),
    );

    it.live("accepts sbp_oauth_ prefix with 40 lowercase hex chars", () =>
      Effect.gen(function* () {
        yield* validateToken(`sbp_oauth_${VALID_HEX_40}`);
      }),
    );

    it.live("accepts all valid hex characters (a-f, 0-9)", () =>
      Effect.gen(function* () {
        yield* validateToken("sbp_abcdef0123456789abcdef0123456789abcdef01");
      }),
    );
  });

  describe("invalid tokens", () => {
    it.live("rejects uppercase hex characters in sbp_ token", () =>
      Effect.gen(function* () {
        const exit = yield* validateToken(`sbp_${"A".repeat(40)}`).pipe(Effect.exit);
        expectInvalidTokenError(exit);
      }),
    );

    it.live("rejects uppercase hex characters in sbp_oauth_ token", () =>
      Effect.gen(function* () {
        const exit = yield* validateToken(`sbp_oauth_${"A".repeat(40)}`).pipe(Effect.exit);
        expectInvalidTokenError(exit);
      }),
    );

    it.live("rejects token that is too short (39 hex chars)", () =>
      Effect.gen(function* () {
        const exit = yield* validateToken(`sbp_${"a".repeat(39)}`).pipe(Effect.exit);
        expectInvalidTokenError(exit);
      }),
    );

    it.live("rejects token that is too long (41 hex chars)", () =>
      Effect.gen(function* () {
        const exit = yield* validateToken(`sbp_${"a".repeat(41)}`).pipe(Effect.exit);
        expectInvalidTokenError(exit);
      }),
    );

    it.live("rejects oauth token that is too short (39 hex chars)", () =>
      Effect.gen(function* () {
        const exit = yield* validateToken(`sbp_oauth_${"a".repeat(39)}`).pipe(Effect.exit);
        expectInvalidTokenError(exit);
      }),
    );

    it.live("rejects oauth token that is too long (41 hex chars)", () =>
      Effect.gen(function* () {
        const exit = yield* validateToken(`sbp_oauth_${"a".repeat(41)}`).pipe(Effect.exit);
        expectInvalidTokenError(exit);
      }),
    );

    it.live("rejects wrong prefix", () =>
      Effect.gen(function* () {
        const exit = yield* validateToken(`tok_${VALID_HEX_40}`).pipe(Effect.exit);
        expectInvalidTokenError(exit);
      }),
    );

    it.live("rejects empty string", () =>
      Effect.gen(function* () {
        const exit = yield* validateToken("").pipe(Effect.exit);
        expectInvalidTokenError(exit);
      }),
    );

    it.live("rejects token with no prefix", () =>
      Effect.gen(function* () {
        const exit = yield* validateToken(VALID_HEX_40).pipe(Effect.exit);
        expectInvalidTokenError(exit);
      }),
    );

    it.live("rejects token with invalid characters (g-z)", () =>
      Effect.gen(function* () {
        const exit = yield* validateToken(`sbp_${"g".repeat(40)}`).pipe(Effect.exit);
        expectInvalidTokenError(exit);
      }),
    );
  });
});
