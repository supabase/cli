import { describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { excludeFlag, toStartStackConfig } from "./start.command.ts";

describe("start command exclude flag", () => {
  test("parses repeated excluded services", async () => {
    const [, exclude] = await Effect.runPromise(
      excludeFlag
        .parse({
          flags: { exclude: ["auth", "postgrest"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(exclude).toEqual(["auth", "postgrest"]);
  });

  test("rejects invalid excluded services", async () => {
    const exit = await Effect.runPromise(
      excludeFlag
        .parse({
          flags: { exclude: ["postgres"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("dedupes excluded services when building stack config", () => {
    expect(toStartStackConfig(["auth", "auth"])).toEqual({ auth: false });
    expect(toStartStackConfig(["auth", "postgrest"])).toEqual({
      auth: false,
      postgrest: false,
    });
  });
});
