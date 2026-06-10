import { describe, expect, it } from "vitest";

import { legacyFindPgpassPassword } from "./legacy-pgpass.ts";

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
