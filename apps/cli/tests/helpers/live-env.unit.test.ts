import { afterEach, describe, expect, it } from "vitest";

import { localStackLiveEnabled } from "./live-env.ts";

const originalMode = process.env["SUPABASE_LIVE_MODE"];
const originalLocalStack = process.env["SUPABASE_LIVE_LOCAL_STACK"];

afterEach(() => {
  if (originalMode === undefined) {
    delete process.env["SUPABASE_LIVE_MODE"];
  } else {
    process.env["SUPABASE_LIVE_MODE"] = originalMode;
  }
  if (originalLocalStack === undefined) {
    delete process.env["SUPABASE_LIVE_LOCAL_STACK"];
  } else {
    process.env["SUPABASE_LIVE_LOCAL_STACK"] = originalLocalStack;
  }
});

describe("localStackLiveEnabled", () => {
  it("defaults to enabled for attached live runs", () => {
    delete process.env["SUPABASE_LIVE_MODE"];
    delete process.env["SUPABASE_LIVE_LOCAL_STACK"];

    expect(localStackLiveEnabled()).toBe(true);
  });

  it("defaults to disabled for managed live runs", () => {
    process.env["SUPABASE_LIVE_MODE"] = "managed";
    delete process.env["SUPABASE_LIVE_LOCAL_STACK"];

    expect(localStackLiveEnabled()).toBe(false);
  });

  it("honors an explicit enabled or disabled value", () => {
    process.env["SUPABASE_LIVE_MODE"] = "managed";
    process.env["SUPABASE_LIVE_LOCAL_STACK"] = "1";
    expect(localStackLiveEnabled()).toBe(true);

    process.env["SUPABASE_LIVE_LOCAL_STACK"] = "0";
    expect(localStackLiveEnabled()).toBe(false);
  });

  it("rejects unsupported values", () => {
    process.env["SUPABASE_LIVE_LOCAL_STACK"] = "yes";

    expect(() => localStackLiveEnabled()).toThrow(
      'Unsupported SUPABASE_LIVE_LOCAL_STACK "yes"; expected "0" or "1"',
    );
  });
});
