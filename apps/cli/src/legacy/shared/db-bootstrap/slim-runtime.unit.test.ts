import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LEGACY_SLIM_BUSYBOX,
  legacySlimBusyboxWgetHealthcheck,
  legacyUsesSlimRuntime,
} from "./slim-runtime.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("legacyUsesSlimRuntime", () => {
  it("requires the flag and a slim ref", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    expect(legacyUsesSlimRuntime("ghcr.io/supabase/cli/storage:v1.70.3")).toBe(true);
    expect(legacyUsesSlimRuntime("supabase/storage-api:v1.70.3")).toBe(false);
  });
});

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
