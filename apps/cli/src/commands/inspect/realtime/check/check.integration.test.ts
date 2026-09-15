import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { REALTIME_EXPLICIT_TARGET, setupRealtime } from "../../../../../tests/helpers/realtime.ts";
import { inspectRealtimeCheck } from "./check.handler.ts";
import type { LegacyInspectRealtimeCheckFlags } from "./check.command.ts";

function checkFlags(
  overrides: Partial<LegacyInspectRealtimeCheckFlags> = {},
): LegacyInspectRealtimeCheckFlags {
  return {
    ...REALTIME_EXPLICIT_TARGET,
    logLevel: "info",
    postgres: Option.none(),
    event: "*",
    filter: Option.none(),
    select: Option.none(),
    channel: "room_a",
    ...overrides,
  };
}

describe("inspect realtime check", () => {
  it.live("reports every step and succeeds when the channel joins", () => {
    const { layer, out } = setupRealtime({ httpStatus: 400 });
    return Effect.gen(function* () {
      yield* inspectRealtimeCheck(checkFlags());

      const printed = out.rawChunks.map((chunk) => chunk.text).join("");
      expect(printed).toContain("✔ resolve");
      expect(printed).toContain("✔ reach");
      expect(printed).toContain("✔ join");
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: "Realtime is reachable and the channel joined.",
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with the rejected-key diagnosis on a 401", () => {
    const { layer, out } = setupRealtime({ httpStatus: 401 });
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimeCheck(checkFlags()).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      const printed = out.rawChunks.map((chunk) => chunk.text).join("");
      expect(printed).toContain("✘ reach");
      expect(printed).toContain("rejected the API key");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with the not-found diagnosis on a 404", () => {
    const { layer, out } = setupRealtime({ httpStatus: 404 });
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimeCheck(checkFlags()).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.rawChunks.map((chunk) => chunk.text).join("")).toContain("No Realtime server at");
    }).pipe(Effect.provide(layer));
  });

  it.live("treats a bare 500 as reachable, since that is what the route answers", () => {
    const { layer, out } = setupRealtime({ httpStatus: 500 });
    return Effect.gen(function* () {
      yield* inspectRealtimeCheck(checkFlags());
      expect(out.rawChunks.map((chunk) => chunk.text).join("")).toContain("✔ reach");
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a gateway failure on a 503", () => {
    const { layer, out } = setupRealtime({ httpStatus: 503 });
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimeCheck(checkFlags()).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.rawChunks.map((chunk) => chunk.text).join("")).toContain(
        "not reachable through its gateway",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("never opens a connection when the endpoint is already broken", () => {
    const { layer, sessions } = setupRealtime({ httpStatus: 401 });
    return Effect.gen(function* () {
      yield* inspectRealtimeCheck(checkFlags()).pipe(Effect.exit);
      expect(sessions.state.specs).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports the join as failed when the server refuses the channel", () => {
    const { layer, out } = setupRealtime({ httpStatus: 400, joinFails: "rejected" });
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimeCheck(checkFlags()).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.rawChunks.map((chunk) => chunk.text).join("")).toContain("✘ join");
    }).pipe(Effect.provide(layer));
  });

  it.live("verifies the database subscription as its own step", () => {
    const { layer, out, sessions } = setupRealtime({ httpStatus: 400 });
    return Effect.gen(function* () {
      yield* inspectRealtimeCheck(checkFlags({ postgres: Option.some("public.messages") }));

      const printed = out.rawChunks.map((chunk) => chunk.text).join("");
      expect(printed).toContain("✔ subscribe");
      expect(printed).toContain("public.messages");
      expect(sessions.state.specs[0]?.postgres?.table).toBe("messages");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the join succeeds but the subscription is refused", () => {
    const { layer, out } = setupRealtime({
      httpStatus: 400,
      subscriptionFails: "Unable to subscribe to changes with given parameters",
    });
    return Effect.gen(function* () {
      const exit = yield* inspectRealtimeCheck(
        checkFlags({ postgres: Option.some("public.nope") }),
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      const printed = out.rawChunks.map((chunk) => chunk.text).join("");
      expect(printed).toContain("✔ join");
      expect(printed).toContain("✘ subscribe");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits the per-step diagnosis in machine format on success", () => {
    const { layer, out } = setupRealtime({ httpStatus: 400, format: "json" });
    return Effect.gen(function* () {
      yield* inspectRealtimeCheck(checkFlags());

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          data: expect.objectContaining({
            channel: "room_a",
            steps: expect.arrayContaining([expect.objectContaining({ name: "join", ok: true })]),
          }),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "gives a rejected key its own error, since the fix is the caller's not the service's",
    () => {
      const { layer, out } = setupRealtime({ httpStatus: 401, format: "json" });
      return Effect.gen(function* () {
        const outcome = yield* inspectRealtimeCheck(checkFlags()).pipe(
          Effect.as("joined" as const),
          Effect.catchTag("RealtimeKeyRejectedError", () => Effect.succeed("key-rejected")),
          Effect.catchTag("RealtimeEndpointUnhealthyError", (cause) =>
            Effect.succeed(`endpoint-${cause.kind}`),
          ),
        );

        expect(outcome).toBe("key-rejected");
        expect(out.events).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("keeps infrastructure failures under the endpoint error, with the kind", () => {
    const { layer } = setupRealtime({ httpStatus: 503 });
    return Effect.gen(function* () {
      const outcome = yield* inspectRealtimeCheck(checkFlags()).pipe(
        Effect.as("joined" as const),
        Effect.catchTag("RealtimeKeyRejectedError", () => Effect.succeed("key-rejected")),
        Effect.catchTag("RealtimeEndpointUnhealthyError", (cause) =>
          Effect.succeed(`endpoint-${cause.kind}`),
        ),
      );

      expect(outcome).toBe("endpoint-server_error");
    }).pipe(Effect.provide(layer));
  });

  it.live("distinguishes a refused subscription from an unhealthy endpoint", () => {
    const { layer } = setupRealtime({
      httpStatus: 400,
      subscriptionFails: "Unable to subscribe to changes with given parameters",
    });
    return Effect.gen(function* () {
      const outcome = yield* inspectRealtimeCheck(
        checkFlags({ postgres: Option.some("public.nope") }),
      ).pipe(
        Effect.as("subscribed" as const),
        Effect.catchTag("RealtimePostgresSubscriptionFailedError", () =>
          Effect.succeed("subscription-refused" as const),
        ),
        Effect.catchTag("RealtimeEndpointUnhealthyError", () =>
          Effect.succeed("endpoint-unhealthy" as const),
        ),
      );
      expect(outcome).toBe("subscription-refused");
    }).pipe(Effect.provide(layer));
  });
});
