import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import {
  AUTO_EXPOSE_NEW_TABLES_DEPRECATION_WARNING,
  excludeFlag,
  resolveAutoExposeNewTables,
  serviceVersionFlag,
} from "./start.command.ts";

describe("start command exclude flag", () => {
  it.effect("parses repeated excluded services", () =>
    Effect.gen(function* () {
      const [, exclude] = yield* excludeFlag.parse({
        flags: { exclude: ["auth", "postgrest"] },
        arguments: [],
      });
      expect(exclude).toEqual(["auth", "postgrest"]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects invalid excluded services", () =>
    Effect.gen(function* () {
      const exit = yield* excludeFlag
        .parse({
          flags: { exclude: ["postgres"] },
          arguments: [],
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("parses repeated service version overrides", () =>
    Effect.gen(function* () {
      const [, overrides] = yield* serviceVersionFlag.parse({
        flags: { "service-version": ["auth=v2.180.0", "postgres=17.4.1.045"] },
        arguments: [],
      });
      expect(overrides).toEqual(["auth=v2.180.0", "postgres=17.4.1.045"]);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("resolveAutoExposeNewTables", () => {
  it("defaults to false (revoke) when the flag is unset", () => {
    expect(resolveAutoExposeNewTables(undefined)).toEqual({
      autoExposeNewTables: false,
      deprecationWarning: undefined,
    });
  });

  it("keeps legacy auto-expose behaviour and warns when explicitly true", () => {
    expect(resolveAutoExposeNewTables(true)).toEqual({
      autoExposeNewTables: true,
      deprecationWarning: AUTO_EXPOSE_NEW_TABLES_DEPRECATION_WARNING,
    });
  });

  it("revokes without warning when explicitly false", () => {
    expect(resolveAutoExposeNewTables(false)).toEqual({
      autoExposeNewTables: false,
      deprecationWarning: undefined,
    });
  });
});
