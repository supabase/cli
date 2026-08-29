import { describe, expect, it } from "vitest";

import { legacySlimWgetHealthcheck } from "./slim-runtime.ts";

describe("legacySlimWgetHealthcheck", () => {
  it("invokes wget --spider", () => {
    const check = legacySlimWgetHealthcheck("http://127.0.0.1:4000/health", {
      header: "Host:realtime-dev",
      startPeriodSeconds: 10,
    });
    expect(check.test).toEqual([
      "CMD",
      "wget",
      "--no-verbose",
      "--tries=1",
      "--spider",
      "--header",
      "Host:realtime-dev",
      "http://127.0.0.1:4000/health",
    ]);
    expect(check.startPeriodSeconds).toBe(10);
  });
});
