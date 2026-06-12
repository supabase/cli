import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  let tmp: string;
  let explicitPath: string;
  let envPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pgpass-fn-"));
    explicitPath = join(tmp, "explicit");
    envPath = join(tmp, "env");
    writeFileSync(explicitPath, "h:5432:d:u:explicit-secret\n");
    writeFileSync(envPath, "h:5432:d:u:env-secret\n");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prefers an explicit passfile over PGPASSFILE from the injected env", () => {
    const env = (name: string): string | undefined => (name === "PGPASSFILE" ? envPath : undefined);
    expect(legacyPgpassPassword("h", 5432, "d", "u", env, explicitPath)).toBe("explicit-secret");
  });

  it("falls back to PGPASSFILE from the injected env when no explicit passfile", () => {
    const env = (name: string): string | undefined => (name === "PGPASSFILE" ? envPath : undefined);
    expect(legacyPgpassPassword("h", 5432, "d", "u", env)).toBe("env-secret");
  });

  it("returns empty string when the resolved passfile is unreadable", () => {
    const env = (): string | undefined => undefined;
    expect(legacyPgpassPassword("h", 5432, "d", "u", env, join(tmp, "missing"))).toBe("");
  });
});
