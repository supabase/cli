import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { findPgpassPassword, pgpassPassword } from "./pgpass.ts";

describe("findPgpassPassword", () => {
  const file = [
    "# a comment",
    "db.example.com:5432:appdb:alice:s3cret",
    "*:*:*:*:wildcard-pass",
  ].join("\n");

  it("returns the password of the first matching entry", () => {
    expect(findPgpassPassword(file, "db.example.com", "5432", "appdb", "alice")).toBe("s3cret");
  });

  it("falls through to a wildcard entry when no exact match", () => {
    expect(findPgpassPassword(file, "other.host", "5432", "db", "bob")).toBe("wildcard-pass");
  });

  it("returns empty string when nothing matches and no wildcard", () => {
    expect(
      findPgpassPassword("db.example.com:5432:appdb:alice:s3cret", "h", "5432", "d", "u"),
    ).toBe("");
  });

  it("honors escaped colons and backslashes in fields (jackc/pgpassfile parity)", () => {
    // Password `a:b\c` written with escaped colon and backslash.
    expect(findPgpassPassword("h:5432:d:u:a\\:b\\\\c", "h", "5432", "d", "u")).toBe("a:b\\c");
  });

  it("skips lines that do not have exactly five fields", () => {
    expect(findPgpassPassword("h:5432:d:u", "h", "5432", "d", "u")).toBe("");
  });
});

describe("pgpassPassword (passfile + injected env precedence)", () => {
  const passfiles = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "pgpass-fn-" });
    const explicitPath = path.join(tmp, "explicit");
    const envPath = path.join(tmp, "env");
    yield* fs.writeFileString(explicitPath, "h:5432:d:u:explicit-secret\n");
    yield* fs.writeFileString(envPath, "h:5432:d:u:env-secret\n");
    return { path, tmp, explicitPath, envPath };
  });

  it.effect("prefers an explicit passfile over PGPASSFILE from the injected env", () =>
    Effect.gen(function* () {
      const { explicitPath, envPath } = yield* passfiles;
      const env = (name: string): string | undefined =>
        name === "PGPASSFILE" ? envPath : undefined;
      expect(yield* pgpassPassword("h", 5432, "d", "u", env, explicitPath)).toBe("explicit-secret");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("falls back to PGPASSFILE from the injected env when no explicit passfile", () =>
    Effect.gen(function* () {
      const { envPath } = yield* passfiles;
      const env = (name: string): string | undefined =>
        name === "PGPASSFILE" ? envPath : undefined;
      expect(yield* pgpassPassword("h", 5432, "d", "u", env)).toBe("env-secret");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("returns empty string when the resolved passfile is unreadable", () =>
    Effect.gen(function* () {
      const { path, tmp } = yield* passfiles;
      const env = (): string | undefined => undefined;
      expect(yield* pgpassPassword("h", 5432, "d", "u", env, path.join(tmp, "missing"))).toBe("");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
