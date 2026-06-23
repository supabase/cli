import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { LegacyDeclarativeNotEnabledError } from "./declarative.errors.ts";
import {
  legacyIsPgDeltaEnabled,
  legacyPgDeltaSuggestion,
  legacyRequirePgDelta,
} from "./declarative.gate.ts";

// `legacyAqua`/`legacyBold` colour their tokens when stderr is a TTY (matching
// Go's lipgloss). Strip ANSI so the assertions validate text content exactly,
// independent of the runner's colour profile.
const stripAnsi = (text: string) =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

const EXPECTED_SUGGESTION =
  "Either pass --experimental or add [experimental.pgdelta] with enabled = true to supabase/config.toml";

describe("legacyIsPgDeltaEnabled", () => {
  it("opens the gate when --experimental is passed even if config disables it", () => {
    expect(legacyIsPgDeltaEnabled(true, false)).toBe(true);
  });

  it("opens the gate when config enables pg-delta even without --experimental", () => {
    expect(legacyIsPgDeltaEnabled(false, true)).toBe(true);
  });

  it("stays closed when neither source enables pg-delta", () => {
    expect(legacyIsPgDeltaEnabled(false, false)).toBe(false);
  });
});

describe("legacyPgDeltaSuggestion", () => {
  it("byte-matches Go's CmdSuggestion text (ANSI stripped)", () => {
    expect(stripAnsi(legacyPgDeltaSuggestion("supabase/config.toml"))).toBe(EXPECTED_SUGGESTION);
  });
});

describe("legacyRequirePgDelta", () => {
  it("passes through when the gate is open", async () => {
    const exit = await Effect.runPromiseExit(
      legacyRequirePgDelta({
        experimental: true,
        pgDeltaEnabled: false,
        configPath: "supabase/config.toml",
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("fails with LegacyDeclarativeNotEnabledError when the gate is closed", async () => {
    const exit = await Effect.runPromiseExit(
      legacyRequirePgDelta({
        experimental: false,
        pgDeltaEnabled: false,
        configPath: "supabase/config.toml",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(error).toBeInstanceOf(LegacyDeclarativeNotEnabledError);
      expect(error?.message).toBe(
        "declarative commands require --experimental flag or pg-delta enabled in config",
      );
      expect(stripAnsi((error as LegacyDeclarativeNotEnabledError).suggestion)).toBe(
        EXPECTED_SUGGESTION,
      );
    }
  });
});
