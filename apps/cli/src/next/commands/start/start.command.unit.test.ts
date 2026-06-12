import { describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import {
  AUTO_EXPOSE_NEW_TABLES_DEPRECATION_WARNING,
  excludeFlag,
  resolveAutoExposeNewTables,
  serviceVersionFlag,
} from "./start.command.ts";

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

  test("parses repeated service version overrides", async () => {
    const [, overrides] = await Effect.runPromise(
      serviceVersionFlag
        .parse({
          flags: { "service-version": ["auth=v2.180.0", "postgres=17.4.1.045"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(overrides).toEqual(["auth=v2.180.0", "postgres=17.4.1.045"]);
  });
});

describe("resolveAutoExposeNewTables", () => {
  test("defaults to false (revoke) when the flag is unset", () => {
    expect(resolveAutoExposeNewTables(undefined)).toEqual({
      autoExposeNewTables: false,
      deprecationWarning: undefined,
    });
  });

  test("keeps legacy auto-expose behaviour and warns when explicitly true", () => {
    expect(resolveAutoExposeNewTables(true)).toEqual({
      autoExposeNewTables: true,
      deprecationWarning: AUTO_EXPOSE_NEW_TABLES_DEPRECATION_WARNING,
    });
  });

  test("revokes without warning when explicitly false", () => {
    expect(resolveAutoExposeNewTables(false)).toEqual({
      autoExposeNewTables: false,
      deprecationWarning: undefined,
    });
  });
});
