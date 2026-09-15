import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { REALTIME_EXPLICIT_TARGET, setupRealtime } from "../../../../../tests/helpers/realtime.ts";
import { inspectRealtimeBroadcast } from "./broadcast.handler.ts";
import type { LegacyInspectRealtimeBroadcastFlags } from "./broadcast.command.ts";

function broadcastFlags(
  overrides: Partial<LegacyInspectRealtimeBroadcastFlags> = {},
): LegacyInspectRealtimeBroadcastFlags {
  return {
    ...REALTIME_EXPLICIT_TARGET,
    logLevel: "info",
    ack: true,
    count: 1,
    channel: "room_a",
    event: "ping",
    payload: '{"n":1}',
    ...overrides,
  };
}

describe("inspect realtime broadcast", () => {
  it.live("sends the parsed payload once and reports the acknowledgement", () => {
    const { layer, out, sessions } = setupRealtime();
    return Effect.gen(function* () {
      yield* inspectRealtimeBroadcast(broadcastFlags());

      expect(sessions.state.broadcasts).toEqual([{ event: "ping", payload: { n: 1 } }]);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: expect.stringContaining("Message acknowledged by the server."),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("sends --count copies", () => {
    const { layer, sessions } = setupRealtime();
    return Effect.gen(function* () {
      yield* inspectRealtimeBroadcast(broadcastFlags({ count: 3 }));
      expect(sessions.state.broadcasts).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });

  it.live("says it is not waiting for an acknowledgement when --ack is off", () => {
    const { layer, out, sessions } = setupRealtime();
    return Effect.gen(function* () {
      yield* inspectRealtimeBroadcast(broadcastFlags({ ack: false }));

      expect(sessions.state.specs[0]?.broadcastAck).toBe(false);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: expect.stringContaining("not waiting for acknowledgement"),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a payload that is not JSON without opening a connection", () => {
    const { layer, sessions } = setupRealtime();
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimeBroadcast(broadcastFlags({ payload: "{nope}" })).pipe(
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(sessions.state.specs).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the server does not acknowledge the message", () => {
    const { layer } = setupRealtime({ broadcastFails: "was not acknowledged: timed out" });
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimeBroadcast(broadcastFlags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the channel cannot be joined", () => {
    const { layer, sessions } = setupRealtime({ joinFails: "rejected" });
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimeBroadcast(broadcastFlags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(sessions.state.broadcasts).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports the send as structured data in machine format", () => {
    const { layer, out } = setupRealtime({ format: "json" });
    return Effect.gen(function* () {
      yield* inspectRealtimeBroadcast(broadcastFlags({ count: 2 }));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          data: expect.objectContaining({
            channel: "room_a",
            event: "ping",
            count: 2,
            acknowledged: true,
          }),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("refuses the -o machine-format flag", () => {
    const { layer, sessions } = setupRealtime({ goOutput: "json" });
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimeBroadcast(broadcastFlags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(sessions.state.specs).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("signs in with --email and joins as that user", () => {
    const { layer, sessions } = setupRealtime({
      httpBody: {
        access_token: "header.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.sig",
        user: { email: "dev@example.com" },
      },
    });
    return Effect.gen(function* () {
      yield* inspectRealtimeBroadcast(
        broadcastFlags({
          email: Option.some("dev@example.com"),
          password: Option.some("secret"),
        }),
      );

      expect(sessions.state.specs[0]?.userToken).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the sign in is rejected", () => {
    const { layer } = setupRealtime({
      httpStatus: 400,
      httpBody: { error_description: "Invalid login credentials" },
    });
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimeBroadcast(
        broadcastFlags({
          email: Option.some("dev@example.com"),
          password: Option.some("wrong"),
        }),
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
