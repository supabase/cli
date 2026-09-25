import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { stripAnsi } from "../../../../../tests/helpers/ansi.ts";
import { DeclarativeNotEnabledError } from "./declarative.errors.ts";
import { isPgDeltaEnabled, pgDeltaSuggestion, requirePgDelta } from "./declarative.gate.ts";

const EXPECTED_SUGGESTION =
  "Either pass --experimental or add [experimental.pgdelta] with enabled = true to supabase/config.toml";

describe("isPgDeltaEnabled", () => {
  it("opens the gate when --experimental is passed even if config disables it", () => {
    expect(isPgDeltaEnabled(true, false)).toBe(true);
  });

  it("opens the gate when config enables pg-delta even without --experimental", () => {
    expect(isPgDeltaEnabled(false, true)).toBe(true);
  });

  it("stays closed when neither source enables pg-delta", () => {
    expect(isPgDeltaEnabled(false, false)).toBe(false);
  });
});

describe("pgDeltaSuggestion", () => {
  it("byte-matches Go's CmdSuggestion text (ANSI stripped)", () => {
    expect(stripAnsi(pgDeltaSuggestion("supabase/config.toml"))).toBe(EXPECTED_SUGGESTION);
  });
});

describe("requirePgDelta", () => {
  it.effect("passes through when the gate is open", () =>
    Effect.gen(function* () {
      const exit = yield* requirePgDelta({
        experimental: true,
        pgDeltaEnabled: false,
        configPath: "supabase/config.toml",
      }).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect("fails with DeclarativeNotEnabledError when the gate is closed", () =>
    Effect.gen(function* () {
      const exit = yield* requirePgDelta({
        experimental: false,
        pgDeltaEnabled: false,
        configPath: "supabase/config.toml",
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(error).toBeInstanceOf(DeclarativeNotEnabledError);
        expect(error?.message).toBe(
          "declarative commands require --experimental flag or pg-delta enabled in config",
        );
        expect(stripAnsi((error as DeclarativeNotEnabledError).suggestion)).toBe(
          EXPECTED_SUGGESTION,
        );
      }
    }),
  );
});
