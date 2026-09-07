import { describe, expect, test } from "vitest";

import { legacySlimWgetHealthcheck, legacySlimWgetWaitCommand } from "./slim-runtime.ts";

describe("legacySlimWgetHealthcheck", () => {
  test("uses only BusyBox-documented wget flags", () => {
    expect(legacySlimWgetHealthcheck("http://127.0.0.1:4000/health")).toEqual({
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:4000/health"],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    });
  });

  test("keeps --header, which BusyBox documents, and an optional start period", () => {
    expect(
      legacySlimWgetHealthcheck("http://127.0.0.1:4000/api/ping", {
        header: "Host:realtime-dev",
        startPeriodSeconds: 10,
      }),
    ).toEqual({
      test: [
        "CMD",
        "wget",
        "-q",
        "--spider",
        "--header",
        "Host:realtime-dev",
        "http://127.0.0.1:4000/api/ping",
      ],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
      startPeriodSeconds: 10,
    });
  });
});

describe("legacySlimWgetWaitCommand", () => {
  test("uses BusyBox -q/-T/--spider, not GNU --no-verbose/--tries", () => {
    expect(legacySlimWgetWaitCommand("http://supabase_analytics_proj:4000/health")).toBe(
      "wget -q -T 2 --spider http://supabase_analytics_proj:4000/health",
    );
  });
});
