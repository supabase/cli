import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "vitest";
import { Effect, Path } from "effect";
import { resolveSupabaseHome } from "./supabase-home.ts";

const testPath = Effect.runSync(Path.Path.pipe(Effect.provide(BunServices.layer)));
const HOME = testPath.join("/home", "test");

describe("resolveSupabaseHome", () => {
  it("returns SUPABASE_HOME when set to a non-empty value", () => {
    expect(resolveSupabaseHome(testPath, "/custom/supabase", HOME)).toBe("/custom/supabase");
  });

  it("trims surrounding whitespace from SUPABASE_HOME", () => {
    expect(resolveSupabaseHome(testPath, "  /custom/supabase  ", HOME)).toBe("/custom/supabase");
  });

  it("falls back to <homeDir>/.supabase when SUPABASE_HOME is unset", () => {
    expect(resolveSupabaseHome(testPath, undefined, HOME)).toBe(testPath.join(HOME, ".supabase"));
  });

  it("falls back to <homeDir>/.supabase when SUPABASE_HOME is empty", () => {
    expect(resolveSupabaseHome(testPath, "", HOME)).toBe(testPath.join(HOME, ".supabase"));
  });

  it("falls back to <homeDir>/.supabase when SUPABASE_HOME is whitespace only", () => {
    expect(resolveSupabaseHome(testPath, "   ", HOME)).toBe(testPath.join(HOME, ".supabase"));
  });
});
