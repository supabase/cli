import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { DatabaseModule } from "../model/capabilities/database.ts";
import { StackVersionUnsupportedError } from "./Errors.ts";
import { resolveEphemeralPostgresRelease } from "./EphemeralPostgres.ts";

describe("resolveEphemeralPostgresRelease", () => {
  it.effect("resolves the catalog default and a major selector", () =>
    Effect.gen(function* () {
      const fallback = yield* resolveEphemeralPostgresRelease();
      expect(fallback.version).toBe(DatabaseModule.defaultVersion);
      expect(fallback.image.length).toBeGreaterThan(0);

      const major = DatabaseModule.defaultVersion.split(".")[0];
      expect(major).toBeDefined();
      if (major === undefined) return;
      const selected = yield* resolveEphemeralPostgresRelease(major);
      expect(selected.version).toBe(fallback.version);
      expect(selected.image).toBe(fallback.image);
    }),
  );

  it.effect("fails for an unknown PostgreSQL version", () =>
    Effect.gen(function* () {
      const exit = yield* resolveEphemeralPostgresRelease("99").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(StackVersionUnsupportedError);
    }),
  );
});
