import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import { suggestAppStart } from "./bootstrap.suggest.ts";

// Colour is identity here so the assertions match the established non-TTY
// (uncoloured) output byte-for-byte.
describe("suggestAppStart", () => {
  it.live("suggests the start command when the workdir is the current directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(suggestAppStart(path, "/home/me/app", "/home/me/app", "npm ci && npm run dev")).toBe(
        "To start your app:\n  npm ci && npm run dev",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("prefixes a cd line when the workdir is nested", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(suggestAppStart(path, "/home/me", "/home/me/app", "npm ci && npm run dev")).toBe(
        "To start your app:\n  cd app\n  npm ci && npm run dev",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("omits the cd line for a '.' relative path", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(suggestAppStart(path, "/home/me/app", "/home/me/app", "supabase start")).toBe(
        "To start your app:\n  supabase start",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("omits the command line when the start command is empty", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(suggestAppStart(path, "/home/me", "/home/me/app", "")).toBe(
        "To start your app:\n  cd app",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("applies the colorize callback to each command line", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const aqua = (line: string) => `<${line}>`;
      expect(suggestAppStart(path, "/home/me", "/home/me/app", "npm run dev", aqua)).toBe(
        "To start your app:\n  <cd app>\n  <npm run dev>",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
