import { describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { excludeFlag } from "../../config/stack-config.ts";

describe("start command exclude flag", () => {
  test("parses repeated excluded services", async () => {
    const [, exclude] = await Effect.runPromise(
      excludeFlag
        .parse({
          flags: { exclude: ["auth", "realtime"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(exclude).toEqual(["auth", "realtime"]);
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
});
