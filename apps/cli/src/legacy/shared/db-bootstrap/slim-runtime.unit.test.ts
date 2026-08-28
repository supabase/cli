import { describe, expect, it } from "vitest";

import { LEGACY_SLIM_BUSYBOX, legacySlimBusyboxWgetHealthcheck } from "./slim-runtime.ts";

describe("legacySlimBusyboxWgetHealthcheck", () => {
  it("invokes busybox wget --spider", () => {
    const check = legacySlimBusyboxWgetHealthcheck("http://127.0.0.1:4000/health", {
      header: "Host:realtime-dev",
      startPeriodSeconds: 10,
    });
    expect(check.test).toEqual([
      "CMD",
      LEGACY_SLIM_BUSYBOX,
      "wget",
      "-q",
      "--spider",
      "--header",
      "Host:realtime-dev",
      "http://127.0.0.1:4000/health",
    ]);
    expect(check.startPeriodSeconds).toBe(10);
  });
});
