import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { logout } from "./logout.handler.ts";
import { emptyEnv, mockCredentials, mockOutput } from "../../../../tests/helpers/mocks.ts";

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function setup(
  opts: {
    existingToken?: string;
    confirmLogout?: boolean;
  } = {},
) {
  const creds = mockCredentials({ existingToken: opts.existingToken });
  const out = mockOutput({ confirmLogout: opts.confirmLogout ?? true });
  const layer = Layer.mergeAll(emptyEnv(), creds.layer, out.layer);
  return { layer, creds, out };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("logout", () => {
  it.live("deletes the token and shows success when logged in", () => {
    const { layer, creds, out } = setup({ existingToken: "sbp_" + "a".repeat(40) });
    return Effect.gen(function* () {
      yield* logout(false);
      expect(creds.deleteWasCalled).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Access token deleted successfully. You are now logged out.",
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("warns when confirming but not logged in", () => {
    const { layer, creds, out } = setup();
    return Effect.gen(function* () {
      yield* logout(false);
      expect(creds.deleteWasCalled).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: "You were not logged in, nothing to do.",
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("does nothing when user declines the confirmation", () => {
    const { layer, creds, out } = setup({
      existingToken: "sbp_" + "a".repeat(40),
      confirmLogout: false,
    });
    return Effect.gen(function* () {
      yield* logout(false);
      expect(creds.deleteWasCalled).toBe(false);
      expect(out.messages.filter((m) => m.type === "success" || m.type === "warn")).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("skips prompt and deletes token when --yes is passed", () => {
    const { layer, creds, out } = setup({ existingToken: "sbp_" + "a".repeat(40) });
    return Effect.gen(function* () {
      yield* logout(true);
      expect(creds.deleteWasCalled).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Access token deleted successfully. You are now logged out.",
        }),
      );
    }).pipe(Effect.provide(layer));
  });
});
