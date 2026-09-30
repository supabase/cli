import { expect, layer } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Path } from "effect";
import { resolveSupabaseHome } from "./supabase-home.ts";

layer(BunServices.layer)("resolveSupabaseHome", (it) => {
  it.effect("returns SUPABASE_HOME when set to a non-empty value", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.join("/home", "test");
      expect(resolveSupabaseHome(path, { SUPABASE_HOME: "/custom/supabase" }, home)).toBe(
        "/custom/supabase",
      );
    }),
  );

  it.effect("trims surrounding whitespace from SUPABASE_HOME", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.join("/home", "test");
      expect(resolveSupabaseHome(path, { SUPABASE_HOME: "  /custom/supabase  " }, home)).toBe(
        "/custom/supabase",
      );
    }),
  );

  it.effect("falls back to <homeDir>/.supabase when SUPABASE_HOME is unset", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.join("/home", "test");
      expect(resolveSupabaseHome(path, {}, home)).toBe(path.join(home, ".supabase"));
    }),
  );

  it.effect("falls back to <homeDir>/.supabase when SUPABASE_HOME is empty", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.join("/home", "test");
      expect(resolveSupabaseHome(path, { SUPABASE_HOME: "" }, home)).toBe(
        path.join(home, ".supabase"),
      );
    }),
  );

  it.effect("falls back to <homeDir>/.supabase when SUPABASE_HOME is whitespace only", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.join("/home", "test");
      expect(resolveSupabaseHome(path, { SUPABASE_HOME: "   " }, home)).toBe(
        path.join(home, ".supabase"),
      );
    }),
  );
});
