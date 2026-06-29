import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSupabaseHome } from "./supabase-home.ts";

const HOME = join("/home", "test");

describe("resolveSupabaseHome", () => {
  it("returns SUPABASE_HOME when set to a non-empty value", () => {
    expect(resolveSupabaseHome({ SUPABASE_HOME: "/custom/supabase" }, HOME)).toBe(
      "/custom/supabase",
    );
  });

  it("trims surrounding whitespace from SUPABASE_HOME", () => {
    expect(resolveSupabaseHome({ SUPABASE_HOME: "  /custom/supabase  " }, HOME)).toBe(
      "/custom/supabase",
    );
  });

  it("falls back to <homeDir>/.supabase when SUPABASE_HOME is unset", () => {
    expect(resolveSupabaseHome({}, HOME)).toBe(join(HOME, ".supabase"));
  });

  it("falls back to <homeDir>/.supabase when SUPABASE_HOME is empty", () => {
    expect(resolveSupabaseHome({ SUPABASE_HOME: "" }, HOME)).toBe(join(HOME, ".supabase"));
  });

  it("falls back to <homeDir>/.supabase when SUPABASE_HOME is whitespace only", () => {
    expect(resolveSupabaseHome({ SUPABASE_HOME: "   " }, HOME)).toBe(join(HOME, ".supabase"));
  });
});
