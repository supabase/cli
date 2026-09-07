import type { Path } from "effect";
import { describe, expect, it } from "vitest";

import {
  legacyFormatMigrationTimestamp,
  legacyGetMigrationPath,
  legacyParseMigrationContent,
} from "./legacy-migration-file.ts";

describe("legacyParseMigrationContent", () => {
  it.each([
    [
      "LF",
      "-- pg-delta: transaction=false\nSET check_function_bodies = off;",
      "-- pg-delta: transaction=false\nSET check_function_bodies = off",
    ],
    [
      "CRLF",
      "-- pg-delta: transaction=false\r\nSET check_function_bodies = off;",
      "-- pg-delta: transaction=false\r\nSET check_function_bodies = off",
    ],
    [
      "a UTF-8 BOM",
      "\uFEFF-- pg-delta: transaction=false\nSET check_function_bodies = off;",
      "-- pg-delta: transaction=false\nSET check_function_bodies = off",
    ],
  ])("recognizes the anchored no-transaction directive with %s", (_name, content, statement) => {
    expect(legacyParseMigrationContent(content)).toEqual({
      statements: [statement],
      transactionMode: "none",
    });
  });

  it("defaults an ordinary migration to transactional execution", () => {
    expect(legacyParseMigrationContent("CREATE TABLE example (id bigint);")).toEqual({
      statements: ["CREATE TABLE example (id bigint)"],
      transactionMode: "transactional",
    });
  });

  it("leaves a later transaction marker as an ordinary transactional comment", () => {
    const content = "-- generated migration\n-- pg-delta: transaction=false\nVACUUM;";
    expect(legacyParseMigrationContent(content)).toEqual({
      statements: [content.slice(0, -1)],
      transactionMode: "transactional",
    });
  });
});

describe("legacyFormatMigrationTimestamp", () => {
  it("formats epoch millis as UTC YYYYMMDDHHMMSS", () => {
    // 2026-06-18T09:08:07.123Z
    const millis = Date.UTC(2026, 5, 18, 9, 8, 7, 123);
    expect(legacyFormatMigrationTimestamp(millis)).toBe("20260618090807");
  });

  it("zero-pads single-digit components", () => {
    const millis = Date.UTC(2001, 0, 2, 3, 4, 5);
    expect(legacyFormatMigrationTimestamp(millis)).toBe("20010102030405");
  });
});

describe("legacyGetMigrationPath", () => {
  it("builds <workdir>/supabase/migrations/<ts>_<name>.sql", () => {
    // A tiny posix Path stand-in keeps this a pure unit test (no Effect runtime).
    const posix = {
      join: (...segments: string[]) => segments.join("/"),
    } as unknown as Path.Path;
    expect(legacyGetMigrationPath(posix, "/repo", "20260618090807", "remote_schema")).toBe(
      "/repo/supabase/migrations/20260618090807_remote_schema.sql",
    );
  });
});
