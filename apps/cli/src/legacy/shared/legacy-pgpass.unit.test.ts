import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { legacyFindPgpassPassword, legacyPgpassPassword } from "./legacy-pgpass.ts";

describe("legacyFindPgpassPassword", () => {
  const file = [
    "# a comment",
    "db.example.com:5432:appdb:alice:s3cret",
    "*:*:*:*:wildcard-pass",
  ].join("\n");

  it("returns the password of the first matching entry", () => {
    expect(legacyFindPgpassPassword(file, "db.example.com", "5432", "appdb", "alice")).toBe(
      "s3cret",
    );
  });

  it("falls through to a wildcard entry when no exact match", () => {
    expect(legacyFindPgpassPassword(file, "other.host", "5432", "db", "bob")).toBe("wildcard-pass");
  });

  it("returns empty string when nothing matches and no wildcard", () => {
    expect(
      legacyFindPgpassPassword("db.example.com:5432:appdb:alice:s3cret", "h", "5432", "d", "u"),
    ).toBe("");
  });

  it("honors escaped colons and backslashes in fields (jackc/pgpassfile parity)", () => {
    // Password `a:b\c` written with escaped colon and backslash.
    expect(legacyFindPgpassPassword("h:5432:d:u:a\\:b\\\\c", "h", "5432", "d", "u")).toBe("a:b\\c");
  });

  it("skips lines that do not have exactly five fields", () => {
    expect(legacyFindPgpassPassword("h:5432:d:u", "h", "5432", "d", "u")).toBe("");
  });
});

describe("legacyPgpassPassword (passfile + injected env precedence)", () => {
  const fixture = (
    run: (
      tmp: string,
      explicitPath: string,
      envPath: string,
      files: ReadonlyMap<string, string>,
    ) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* fs.makeTempDirectory({ prefix: "pgpass-fn-" });
      const explicitPath = path.join(tmp, "explicit");
      const envPath = path.join(tmp, "env");
      yield* fs.writeFileString(explicitPath, "h:5432:d:u:explicit-secret\n");
      yield* fs.writeFileString(envPath, "h:5432:d:u:env-secret\n");
      const files = new Map([
        [explicitPath, yield* fs.readFileString(explicitPath)],
        [envPath, yield* fs.readFileString(envPath)],
      ]);
      yield* run(tmp, explicitPath, envPath, files);
      yield* fs.remove(tmp, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));

  it.effect("prefers an explicit passfile over PGPASSFILE from the injected env", () =>
    fixture((_tmp, explicitPath, envPath, files) => {
      const env = (name: string): string | undefined =>
        name === "PGPASSFILE" ? envPath : undefined;
      return Effect.sync(() =>
        expect(
          legacyPgpassPassword("h", 5432, "d", "u", env, explicitPath, {
            join: (base, ...parts) => [base, ...parts].join("/"),
            files,
          }),
        ).toBe("explicit-secret"),
      );
    }),
  );

  it.effect("falls back to PGPASSFILE from the injected env when no explicit passfile", () =>
    fixture((_tmp, _explicitPath, envPath, files) => {
      const env = (name: string): string | undefined =>
        name === "PGPASSFILE" ? envPath : undefined;
      return Effect.sync(() =>
        expect(
          legacyPgpassPassword("h", 5432, "d", "u", env, undefined, {
            join: (base, ...parts) => [base, ...parts].join("/"),
            files,
          }),
        ).toBe("env-secret"),
      );
    }),
  );

  it.effect("returns empty string when the resolved passfile is unreadable", () =>
    fixture((tmp, _explicitPath, _envPath, files) => {
      const env = (): string | undefined => undefined;
      return Effect.sync(() =>
        expect(
          legacyPgpassPassword("h", 5432, "d", "u", env, `${tmp}/missing`, {
            join: (base, ...parts) => [base, ...parts].join("/"),
            files,
          }),
        ).toBe(""),
      );
    }),
  );
});
