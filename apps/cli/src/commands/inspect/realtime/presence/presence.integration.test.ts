import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { REALTIME_EXPLICIT_TARGET, setupRealtime } from "../../../../../tests/helpers/realtime.ts";
import { inspectRealtimePresence } from "./presence.handler.ts";
import type { LegacyInspectRealtimePresenceFlags } from "./presence.command.ts";

function presenceFlags(
  overrides: Partial<LegacyInspectRealtimePresenceFlags> = {},
): LegacyInspectRealtimePresenceFlags {
  return {
    ...REALTIME_EXPLICIT_TARGET,
    logLevel: "info",
    as: Option.none(),
    channel: "room_a",
    ...overrides,
  };
}

const SYNC_FRAME = { category: "presence" as const, event: "sync", payload: { state: {} } };

describe("inspect realtime presence", () => {
  it.live("prints an empty channel as nobody present", () => {
    const { layer, out } = setupRealtime({ frames: [SYNC_FRAME] });
    return Effect.gen(function* () {
      yield* inspectRealtimePresence(presenceFlags());

      expect(out.rawChunks.map((chunk) => chunk.text).join("")).toContain("(nobody present)");
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: 'Nobody is present on "room_a".',
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("lists each member and how many connections it has", () => {
    const { layer, out } = setupRealtime({
      frames: [SYNC_FRAME],
      presence: {
        debugger: [{ presence_ref: "r1", name: "debugger" }],
        app: [{ presence_ref: "r2" }, { presence_ref: "r3" }],
      },
    });
    return Effect.gen(function* () {
      yield* inspectRealtimePresence(presenceFlags());

      const printed = out.rawChunks.map((chunk) => chunk.text).join("");
      expect(printed).toContain("debugger  1 connection");
      expect(printed).toContain("app  2 connections");
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: '2 members present on "room_a".',
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("tracks a named state with --as and enables presence for the session", () => {
    const { layer, sessions } = setupRealtime({
      frames: [SYNC_FRAME],
      presence: { debugger: [{ presence_ref: "r1", name: "debugger" }] },
    });
    return Effect.gen(function* () {
      yield* inspectRealtimePresence(presenceFlags({ as: Option.some("debugger") }));

      expect(sessions.state.tracked[0]).toEqual(
        expect.objectContaining({ name: "debugger", online_at: expect.any(String) }),
      );
      expect(sessions.state.specs[0]?.presence).toBe(true);
      expect(sessions.state.specs[0]?.presenceKey).toBe("debugger");
    }).pipe(Effect.provide(layer));
  });

  it.live("warns when the server sends no presence state at all", () => {
    const { layer, out } = setupRealtime({ frames: [] });
    return Effect.gen(function* () {
      yield* inspectRealtimePresence(presenceFlags());

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: expect.stringContaining("no presence state"),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the channel cannot be joined", () => {
    const { layer } = setupRealtime({ joinFails: "rejected" });
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimePresence(presenceFlags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports the presence state as structured data in machine format", () => {
    const { layer, out } = setupRealtime({
      frames: [SYNC_FRAME],
      presence: { debugger: [{ presence_ref: "r1", name: "debugger" }] },
      format: "json",
    });
    return Effect.gen(function* () {
      yield* inspectRealtimePresence(presenceFlags());

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          data: expect.objectContaining({
            channel: "room_a",
            members: 1,
            tracked: false,
            presence: { debugger: [{ presence_ref: "r1", name: "debugger" }] },
          }),
        }),
      );
    }).pipe(Effect.provide(layer));
  });
});
