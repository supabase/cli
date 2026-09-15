import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Option } from "effect";

import {
  realtimeChannelName,
  requirePositive,
  parseRealtimeCategories,
  parseRealtimeDuration,
  parseRealtimePayload,
  parseRealtimePostgresTarget,
  parseRealtimeReplaySince,
  parseRealtimeSelect,
  realtimeTargetChoice,
  resolveRealtimePostgresSpec,
} from "./realtime.flags.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect);
const runExit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSyncExit(effect);

describe("parseRealtimeCategories", () => {
  it("defaults to the channel categories plus error", () => {
    expect([...run(parseRealtimeCategories(Option.none()))].sort()).toEqual([
      "broadcast",
      "error",
      "postgres",
      "presence",
      "system",
    ]);
  });

  it("accepts a comma separated list, trimming and lowercasing", () => {
    expect([...run(parseRealtimeCategories(Option.some(" Broadcast , postgres ")))]).toEqual([
      "broadcast",
      "postgres",
    ]);
  });

  it("expands all to every category, including the client internals", () => {
    expect([...run(parseRealtimeCategories(Option.some("all")))]).toContain("transport");
    expect([...run(parseRealtimeCategories(Option.some("all")))]).toContain("channel");
  });

  it("rejects an unknown category", () => {
    const exit = runExit(parseRealtimeCategories(Option.some("broadcast,bogus")));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects a value that selects nothing", () => {
    expect(Exit.isFailure(runExit(parseRealtimeCategories(Option.some(" , "))))).toBe(true);
  });
});

describe("parseRealtimeDuration", () => {
  it("returns none when the flag is absent", () => {
    expect(Option.isNone(run(parseRealtimeDuration(Option.none())))).toBe(true);
  });

  it.each([
    ["30", Duration.seconds(30)],
    ["30s", Duration.seconds(30)],
    ["500ms", Duration.millis(500)],
    ["5m", Duration.minutes(5)],
    ["2h", Duration.hours(2)],
  ])("parses %s", (input, expected) => {
    const parsed = run(parseRealtimeDuration(Option.some(input)));
    expect(Option.getOrThrow(parsed)).toStrictEqual(expected);
  });

  it.each(["abc", "-5", "5x", "", "0"])("rejects %s", (input) => {
    expect(Exit.isFailure(runExit(parseRealtimeDuration(Option.some(input))))).toBe(true);
  });
});

describe("parseRealtimePostgresTarget", () => {
  it("reads schema.table", () => {
    expect(run(parseRealtimePostgresTarget("public.messages"))).toEqual({
      schema: "public",
      table: "messages",
    });
  });

  it("treats a bare schema as every table in it", () => {
    expect(run(parseRealtimePostgresTarget(" public "))).toEqual({
      schema: "public",
      table: "*",
    });
  });

  it.each(["", "  ", "a.b.c", "public."])("rejects %s", (input) => {
    expect(Exit.isFailure(runExit(parseRealtimePostgresTarget(input)))).toBe(true);
  });
});

describe("parseRealtimeSelect", () => {
  it("splits, trims and de-duplicates the column list", () => {
    expect(parseRealtimeSelect(Option.some(" id , title ,id, "))).toEqual(["id", "title"]);
  });

  it("returns no columns when the flag is absent, meaning every column", () => {
    expect(parseRealtimeSelect(Option.none())).toEqual([]);
  });
});

describe("resolveRealtimePostgresSpec", () => {
  it("returns undefined when --postgres was not passed", () => {
    const spec = run(
      resolveRealtimePostgresSpec({
        postgres: Option.none(),
        event: "*",
        filter: Option.none(),
        select: Option.none(),
      }),
    );
    expect(spec).toBeUndefined();
  });

  it("builds the full binding from the related flags", () => {
    expect(
      run(
        resolveRealtimePostgresSpec({
          postgres: Option.some("public.messages"),
          event: "INSERT",
          filter: Option.some("id=eq.1"),
          select: Option.some("id,title"),
        }),
      ),
    ).toEqual({
      schema: "public",
      table: "messages",
      event: "INSERT",
      filter: "id=eq.1",
      select: ["id", "title"],
    });
  });
});

describe("parseRealtimePayload", () => {
  it("parses a JSON payload", () => {
    expect(run(parseRealtimePayload('{"n":1}'))).toEqual({ n: 1 });
  });

  it("rejects text that is not JSON", () => {
    expect(Exit.isFailure(runExit(parseRealtimePayload("{nope}")))).toBe(true);
  });
});

describe("realtimeTargetChoice", () => {
  it("reports the named target, and nothing when neither flag is set", () => {
    expect(realtimeTargetChoice({ local: true, linked: false })).toBe("local");
    expect(realtimeTargetChoice({ local: false, linked: true })).toBe("linked");
    expect(realtimeTargetChoice({ local: false, linked: false })).toBeUndefined();
  });
});

describe("parseRealtimeReplaySince", () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);

  it("returns undefined when the flag is absent", () => {
    expect(run(parseRealtimeReplaySince(Option.none(), now))).toBeUndefined();
  });

  it("reads an age as a point that far in the past", () => {
    expect(run(parseRealtimeReplaySince(Option.some("5m"), now))).toBe(now - 5 * 60_000);
    expect(run(parseRealtimeReplaySince(Option.some("30"), now))).toBe(now - 30_000);
  });

  it("reads an absolute timestamp", () => {
    expect(run(parseRealtimeReplaySince(Option.some("2026-01-02T11:00:00Z"), now))).toBe(
      Date.UTC(2026, 0, 2, 11, 0, 0),
    );
  });

  it("rejects text that is neither", () => {
    expect(Exit.isFailure(runExit(parseRealtimeReplaySince(Option.some("yesterday"), now)))).toBe(
      true,
    );
  });
});

describe("realtimeChannelName", () => {
  it("strips the wire protocol's reserved topic prefix", () => {
    expect(realtimeChannelName("realtime:room_a")).toEqual({
      channel: "room_a",
      strippedTopicPrefix: true,
    });
  });

  it("leaves a channel whose own name contains a colon alone", () => {
    expect(realtimeChannelName("room:42")).toEqual({
      channel: "room:42",
      strippedTopicPrefix: false,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(realtimeChannelName("  room_a  ").channel).toBe("room_a");
  });
});

describe("requirePositive", () => {
  it("accepts one and above", () => {
    expect(run(requirePositive("count", 1))).toBe(1);
  });

  it.each([0, -1])("rejects %s", (value) => {
    expect(Exit.isFailure(runExit(requirePositive("count", value)))).toBe(true);
  });
});
