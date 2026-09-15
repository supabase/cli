import { describe, expect, it } from "vitest";

import {
  cleanRealtimePayload,
  isRealtimeHeartbeat,
  realtimeCategoryOfLogKind,
  realtimeEventLabel,
  redactRealtimeText,
  unwrapRealtimePayload,
} from "./realtime.events.ts";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24ifQ.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

describe("redactRealtimeText", () => {
  it("redacts the apikey query param the SDK logs with the socket URL", () => {
    expect(
      redactRealtimeText("connecting to wss://abc.supabase.co/realtime/v1?apikey=secret1234"),
    ).toBe("connecting to wss://abc.supabase.co/realtime/v1?apikey=[redacted]");
  });

  it("redacts token and access_token params", () => {
    expect(redactRealtimeText("?token=abc&access_token=def")).toBe(
      "?token=[redacted]&access_token=[redacted]",
    );
  });

  it("redacts a bare JWT anywhere in the text", () => {
    expect(redactRealtimeText(`joined with ${JWT} ok`)).toBe("joined with [redacted] ok");
  });

  it("redacts publishable and secret keys, which are not JWTs", () => {
    expect(redactRealtimeText("key sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH")).toBe(
      "key [redacted]",
    );
    expect(redactRealtimeText("key sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz")).toBe(
      "key [redacted]",
    );
  });

  it("leaves text without credentials untouched", () => {
    expect(redactRealtimeText("realtime:room_a phx_join (6, 6)")).toBe(
      "realtime:room_a phx_join (6, 6)",
    );
  });
});

describe("cleanRealtimePayload", () => {
  it("drops null, undefined and empty members", () => {
    expect(cleanRealtimePayload({ a: 1, b: null, c: undefined, d: "" })).toEqual({ a: 1 });
  });

  it("returns undefined for a payload with nothing left in it", () => {
    expect(cleanRealtimePayload({ b: null })).toBeUndefined();
    expect(cleanRealtimePayload([])).toBeUndefined();
  });

  it("truncates a long string and reports its real length", () => {
    const cleaned = cleanRealtimePayload("x".repeat(2100));
    expect(cleaned).toBe(`${"x".repeat(2048)}… (2100 chars)`);
  });

  it("stops descending past the depth limit", () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < 12; i += 1) nested = { nested };
    expect(JSON.stringify(cleanRealtimePayload(nested))).toContain("[nested]");
  });

  it("redacts credentials inside nested values", () => {
    expect(cleanRealtimePayload({ url: `wss://x/socket?apikey=${JWT}` })).toEqual({
      url: "wss://x/socket?apikey=[redacted]",
    });
  });

  it("reduces an Error to its name and message", () => {
    expect(cleanRealtimePayload(new TypeError("boom"))).toEqual({
      name: "TypeError",
      message: "boom",
    });
  });
});

describe("unwrapRealtimePayload", () => {
  it("unwraps the single-key data envelope the SDK logger adds", () => {
    expect(unwrapRealtimePayload({ data: { status: "ok" } })).toEqual({ status: "ok" });
  });

  it("leaves a payload with other keys alone", () => {
    expect(unwrapRealtimePayload({ data: 1, other: 2 })).toEqual({ data: 1, other: 2 });
  });
});

describe("isRealtimeHeartbeat", () => {
  it("matches both the heartbeat push and its reply on the phoenix topic", () => {
    expect(isRealtimeHeartbeat("push: phoenix heartbeat (7)")).toBe(true);
    expect(isRealtimeHeartbeat("receive: ok phoenix phx_reply (7)")).toBe(true);
  });

  it("does not match ordinary channel traffic", () => {
    expect(isRealtimeHeartbeat("receive: ok realtime:room_a phx_reply (6)")).toBe(false);
  });
});

describe("realtimeEventLabel", () => {
  it.each([
    ["connected to wss://abc/realtime/v1", "Transport connected"],
    ["connecting to wss://abc/realtime/v1", "Transport connecting"],
    ["realtime:room_a phx_join (6, 6)", "Joining room_a"],
    ["ok realtime:room_a phx_reply (6, 6)", "Joined room_a"],
    ["error realtime:room_a phx_reply (6, 6)", "Join rejected"],
    ["realtime:room_a phx_leave (7)", "Leaving room_a"],
    ["realtime:room_a phx_close", "Channel closed"],
    ["realtime:room_a phx_error", "Channel error"],
    ["postgres_changes", "Database change"],
    ["presence_state", "Presence sync"],
    ["presence_diff", "Presence change"],
  ])("labels %s as %s", (event, expected) => {
    expect(realtimeEventLabel(event)).toBe(expected);
  });

  it("falls back to the raw event name when there is nothing to parse", () => {
    expect(realtimeEventLabel("ping")).toBe("ping");
    expect(realtimeEventLabel("")).toBe("");
  });
});

describe("realtimeCategoryOfLogKind", () => {
  it("maps the SDK's log kinds onto categories, defaulting to channel", () => {
    expect(realtimeCategoryOfLogKind("error")).toBe("error");
    expect(realtimeCategoryOfLogKind("transport")).toBe("transport");
    expect(realtimeCategoryOfLogKind("channel")).toBe("channel");
    expect(realtimeCategoryOfLogKind("something-new")).toBe("channel");
  });
});
