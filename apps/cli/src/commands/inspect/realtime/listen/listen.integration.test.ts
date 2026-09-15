import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import {
  REALTIME_EXPLICIT_TARGET,
  setupRealtime,
  type SetupRealtimeOptions,
} from "../../../../../tests/helpers/realtime.ts";
import { inspectRealtimeListen } from "./listen.handler.ts";
import type { LegacyInspectRealtimeListenFlags } from "./listen.command.ts";

function listenFlags(
  overrides: Partial<LegacyInspectRealtimeListenFlags> = {},
): LegacyInspectRealtimeListenFlags {
  return {
    ...REALTIME_EXPLICIT_TARGET,
    logLevel: "info",
    categories: Option.none(),
    fullPayload: false,
    presence: false,
    as: Option.none(),
    postgres: Option.none(),
    event: "*",
    filter: Option.none(),
    select: Option.none(),
    duration: Option.none(),
    events: Option.none(),
    replaySince: Option.none(),
    replayLimit: Option.none(),
    replicationReady: false,
    channel: "room_a",
    ...overrides,
  };
}

const BROADCAST_FRAME = {
  category: "broadcast" as const,
  event: "ping",
  payload: { type: "broadcast", event: "ping", payload: { n: 1 } },
};

function setup(opts: SetupRealtimeOptions = {}) {
  return setupRealtime({ frames: [BROADCAST_FRAME], ...opts });
}

describe("inspect realtime listen", () => {
  it.live("prints the frames it received and a summary of what arrived", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(listenFlags());

      const printed = out.rawChunks.map((chunk) => chunk.text).join("");
      expect(printed).toContain("CATEGORY");
      expect(printed).toContain("broadcast");
      expect(printed).toContain("ping");
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: expect.stringContaining("1 frame: broadcast 1"),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("says what it subscribed to before any frame arrives", () => {
    const { layer, out } = setup({
      frames: [],
      subscriptionFails: undefined,
    });
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(
        listenFlags({ presence: true, postgres: Option.some("public.messages") }),
      );

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: expect.stringContaining(
            'Listening on public channel "room_a" for broadcast, presence, all changes on public.messages',
          ),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a channel that never joined as a failure", () => {
    const { layer } = setup({ joinFails: "rejected" });
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimeListen(listenFlags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("warns that no database changes will arrive when the subscription is refused", () => {
    const { layer, out } = setup({
      frames: [],
      subscriptionFails: "Unable to subscribe to changes with given parameters",
    });
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(listenFlags({ postgres: Option.some("public.messages") }));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: expect.stringContaining("No database changes will arrive"),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("treats an empty tail as a finding rather than a failure", () => {
    const { layer, out } = setup({ frames: [], suppressed: 4 });
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(listenFlags());

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: expect.stringContaining("No frames received (4 filtered out by --categories)"),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("stops after --events frames", () => {
    const { layer, out } = setup({
      frames: [BROADCAST_FRAME, { ...BROADCAST_FRAME, event: "pong" }],
    });
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(listenFlags({ events: Option.some(1) }));

      const printed = out.rawChunks.map((chunk) => chunk.text).join("");
      expect(printed).toContain("ping");
      expect(printed).not.toContain("pong");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits one structured frame per event in machine format", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(listenFlags());

      expect(out.events).toContainEqual(
        expect.objectContaining({
          type: "realtime-frame",
          category: "broadcast",
          event: "ping",
          payload: BROADCAST_FRAME.payload,
        }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Realtime tail complete.",
          data: expect.objectContaining({ frames: 1, stoppedBy: "events" }),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects an unknown --categories value before opening a connection", () => {
    const { layer, sessions } = setup();
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimeListen(
        listenFlags({ categories: Option.some("bogus") }),
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(sessions.state.specs).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a malformed --postgres target before opening a connection", () => {
    const { layer, sessions } = setup();
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimeListen(
        listenFlags({ postgres: Option.some("a.b.c") }),
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(sessions.state.specs).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("passes the resolved subscription and identity through to the session", () => {
    const { layer, sessions } = setup();
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(
        listenFlags({
          postgres: Option.some("public.messages"),
          event: "INSERT",
          filter: Option.some("id=eq.1"),
          select: Option.some("id, title"),
          private: true,
          categories: Option.some("broadcast"),
        }),
      );

      const spec = sessions.state.specs[0];
      expect(spec?.privateChannel).toBe(true);
      expect(spec?.postgres).toEqual({
        schema: "public",
        table: "messages",
        event: "INSERT",
        filter: "id=eq.1",
        select: ["id", "title"],
      });
      expect([...(spec?.categories ?? [])]).toEqual(["broadcast"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("asks the server to replay broadcasts from the requested point", () => {
    const { layer, sessions } = setup();
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(
        listenFlags({ replaySince: Option.some("5m"), replayLimit: Option.some(20) }),
      );

      const replay = sessions.state.specs[0]?.broadcastReplay;
      expect(replay?.limit).toBe(20);
      expect(replay?.since).toBeLessThanOrEqual(Date.now());
      expect(replay?.since).toBeGreaterThan(Date.now() - 6 * 60_000);
    }).pipe(Effect.provide(layer));
  });

  it.live("waits for the replication connection when asked, and warns when it never comes", () => {
    const { layer, out, sessions } = setup({
      frames: [],
      replicationFails: "the replication connection was refused",
    });
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(listenFlags({ replicationReady: true }));

      expect(sessions.state.specs[0]?.replicationReady).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: expect.stringContaining("replication connection was not established"),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("says when the connection bypasses RLS", () => {
    const { layer, out, sessions } = setup();
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(
        listenFlags({ secretKey: Option.some("sb_secret_testtesttest") }),
      );

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: expect.stringContaining("bypasses RLS"),
        }),
      );
      expect(sessions.state.specs).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("refuses an unbounded tail in json mode, which could never emit anything", () => {
    const { layer, sessions } = setup({ format: "json" });
    return Effect.gen(function* () {
      const outcome = yield* inspectRealtimeListen(listenFlags()).pipe(
        Effect.as("ran" as const),
        Effect.catchTag("RealtimeInvalidOptionError", (cause) => Effect.succeed(cause.message)),
      );

      expect(outcome).toContain("needs --duration with --output-format json");
      expect(sessions.state.specs).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("allows an unbounded tail when frames stream as they arrive", () => {
    const { layer, sessions } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(listenFlags());
      expect(sessions.state.specs).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("holds a tracked presence for the life of the tail with --as", () => {
    const { layer, sessions } = setup();
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(listenFlags({ as: Option.some("watcher") }));

      expect(sessions.state.specs[0]?.presence).toBe(true);
      expect(sessions.state.specs[0]?.presenceKey).toBe("watcher");
      expect(sessions.state.tracked[0]).toEqual(
        expect.objectContaining({ name: "watcher", online_at: expect.any(String) }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("explains a confirmed database subscription that delivered nothing", () => {
    const { layer, out } = setup({ frames: [] });
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(listenFlags({ postgres: Option.some("public.messages") }));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: expect.stringContaining("confirmed but no database changes arrived"),
        }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: expect.stringContaining("RLS on the table does not grant the anon role"),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("does not blame RLS when already connected as a user", () => {
    const { layer, out } = setup({
      frames: [],
      httpBody: {
        access_token: "h.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.s",
        user: { email: "d@e.com" },
      },
    });
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(
        listenFlags({
          postgres: Option.some("public.messages"),
          email: Option.some("d@e.com"),
          password: Option.some("pw"),
        }),
      );

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: expect.stringContaining("RLS does not grant this user"),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry even when the join fails", () => {
    const { layer, telemetry } = setup({ joinFails: "timed_out" });
    return Effect.gen(function* () {
      yield* inspectRealtimeListen(listenFlags()).pipe(Effect.exit);
      expect(telemetry.flushCount).toBeGreaterThan(0);
    }).pipe(Effect.provide(layer));
  });
});
