import { describe, expect, test } from "vitest";
import {
  channelForTag,
  homebrewClassName,
  homebrewConflictsLine,
  isPublishableNpmTag,
  releaseBranchForTag,
} from "./release-channels.ts";

describe("isPublishableNpmTag", () => {
  test.each(["latest", "beta", "next", "alpha", "v2.stable", "v10.stable"])("accepts %s", (tag) => {
    expect(isPublishableNpmTag(tag)).toBe(true);
  });

  test.each(["stable", "v2.x", "2.stable", "v0.stable", "next.1", "v2.stable.1", ""])(
    "rejects %j",
    (tag) => {
      expect(isPublishableNpmTag(tag)).toBe(false);
    },
  );
});

describe("homebrewClassName", () => {
  test.each([
    ["supabase", "Supabase"],
    ["supabase-beta", "SupabaseBeta"],
    ["supabase-shim-poc", "SupabaseShimPoc"],
    ["supabase@2", "SupabaseAT2"],
    ["supabase@10", "SupabaseAT10"],
  ])("%s -> %s", (name, expected) => {
    expect(homebrewClassName(name)).toBe(expected);
  });
});

describe("homebrewConflictsLine", () => {
  test.each(["supabase@2", "supabase@10"])("%s conflicts with the unversioned formula", (name) => {
    expect(homebrewConflictsLine(name)).toBe(
      '  conflicts_with "supabase", because: "both install a `supabase` binary"',
    );
  });

  test.each(["supabase", "supabase-beta", "supabase-shim-poc"])(
    "%s declares no conflict",
    (name) => {
      expect(homebrewConflictsLine(name)).toBeUndefined();
    },
  );
});

describe("releaseBranchForTag", () => {
  test.each([
    ["v3.0.0-beta.1", false, "develop"],
    ["v3.0.0-beta.1", true, "develop"],
    ["v3.0.0-next.4", false, "next"],
    ["v2.99.0-alpha.1", false, "main"],
    ["v3.0.0", true, "main"],
    ["v2.151.1", true, "main"],
    ["v2.151.1", false, "v2.x"],
    ["v10.2.0", false, "v10.x"],
  ])("%s (onMain=%s) -> %s", (tag, onMain, expected) => {
    expect(releaseBranchForTag(tag, onMain)).toBe(expected);
  });
});

describe("channelForTag", () => {
  test.each([
    ["v3.0.0-beta.1", "beta"],
    ["v3.0.0-next.4", "next"],
    ["v2.99.0-alpha.1", "alpha"],
    ["v2.151.1", "latest"],
  ])("%s -> %s", (tag, expected) => {
    expect(channelForTag(tag)).toBe(expected);
  });
});
