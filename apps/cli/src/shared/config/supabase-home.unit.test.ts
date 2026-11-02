import { expect, layer } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Path } from "effect";

import { withConfigEnv } from "../../../tests/helpers/command-mocks.ts";
import { readSupabaseHome } from "./supabase-home.ts";

layer(BunServices.layer)("readSupabaseHome", (it) => {
  const resolve = (env: Record<string, string>) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.join("/home", "test");
      return { home, path, resolved: yield* withConfigEnv(env, readSupabaseHome(path, home)) };
    });

  it.effect("returns SUPABASE_HOME when set to a non-empty value", () =>
    Effect.gen(function* () {
      const { resolved } = yield* resolve({ SUPABASE_HOME: "/custom/supabase" });
      expect(resolved).toBe("/custom/supabase");
    }),
  );

  it.effect("trims surrounding whitespace from SUPABASE_HOME", () =>
    Effect.gen(function* () {
      const { resolved } = yield* resolve({ SUPABASE_HOME: "  /custom/supabase  " });
      expect(resolved).toBe("/custom/supabase");
    }),
  );

  it.effect("falls back to <homeDir>/.supabase when SUPABASE_HOME is unset", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.join("/home", "test");
      const resolved = yield* readSupabaseHome(path, home).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
      );
      expect(resolved).toBe(path.join(home, ".supabase"));
    }),
  );

  it.effect("falls back to <homeDir>/.supabase when SUPABASE_HOME is empty", () =>
    Effect.gen(function* () {
      const { home, path, resolved } = yield* resolve({ SUPABASE_HOME: "" });
      expect(resolved).toBe(path.join(home, ".supabase"));
    }),
  );

  it.effect("falls back to <homeDir>/.supabase when SUPABASE_HOME is whitespace only", () =>
    Effect.gen(function* () {
      const { home, path, resolved } = yield* resolve({ SUPABASE_HOME: "   " });
      expect(resolved).toBe(path.join(home, ".supabase"));
    }),
  );
});
