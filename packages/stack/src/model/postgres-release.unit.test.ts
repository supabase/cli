import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { catalogEntryFor } from "./WorkloadCatalog.ts";
import { resolvePostgresRelease } from "./PostgresRelease.ts";
import { StackVersionUnsupportedError } from "../public/Errors.ts";

describe("resolvePostgresRelease", () => {
  it.effect("resolves the catalog default and a major selector", () =>
    Effect.gen(function* () {
      const entry = catalogEntryFor("database:database");
      const fallback = yield* resolvePostgresRelease();
      expect(fallback.version).toBe(entry.defaultVersion);
      expect(fallback.image.length).toBeGreaterThan(0);

      const major = entry.defaultVersion.split(".")[0];
      expect(major).toBeDefined();
      if (major === undefined) return;
      const selected = yield* resolvePostgresRelease(major);
      expect(selected).toEqual(fallback);
    }),
  );

  it.effect("maps a superseded exact pin to the current catalog release of that major", () =>
    Effect.gen(function* () {
      const major = catalogEntryFor("database:database").defaultVersion.split(".")[0];
      expect(major).toBeDefined();
      if (major === undefined) return;
      const selected = yield* resolvePostgresRelease(`${major}.0.0.1`);
      expect(selected.version).toBe(catalogEntryFor("database:database").defaultVersion);
    }),
  );

  it.effect("fails for an unknown PostgreSQL version", () =>
    Effect.gen(function* () {
      const exit = yield* resolvePostgresRelease("99").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(StackVersionUnsupportedError);
    }),
  );
});
