import { describe, expect, it } from "vitest";

import {
  LEGACY_MIGRATION_VERSION_MAX,
  legacyFormatTimestampVersion,
  legacyParseMigrationVersion,
} from "./legacy-migration-timestamp.format.ts";

describe("legacyFormatTimestampVersion", () => {
  it("reformats a valid YYYYMMDDHHMMSS version", () => {
    expect(legacyFormatTimestampVersion("20220727064246")).toBe("2022-07-27 06:42:46");
  });

  it("passes through short numeric versions (Go time.Parse errors → input)", () => {
    expect(legacyFormatTimestampVersion("0")).toBe("0");
    expect(legacyFormatTimestampVersion("1")).toBe("1");
  });

  it("passes through non-numeric versions", () => {
    expect(legacyFormatTimestampVersion("abc")).toBe("abc");
  });

  it("passes through out-of-range months/days like Go's strict parse", () => {
    expect(legacyFormatTimestampVersion("20221327064246")).toBe("20221327064246"); // month 13
    expect(legacyFormatTimestampVersion("20220230000000")).toBe("20220230000000"); // Feb 30
    expect(legacyFormatTimestampVersion("20220727256046")).toBe("20220727256046"); // hour 25
  });

  it("passes through versions that are not exactly 14 digits", () => {
    expect(legacyFormatTimestampVersion("202207270642460")).toBe("202207270642460"); // 15 digits
  });
});

describe("legacyParseMigrationVersion", () => {
  it("parses a digit-only version to a BigInt", () => {
    expect(legacyParseMigrationVersion("20220727064246")).toBe(20220727064246n);
    expect(legacyParseMigrationVersion("0")).toBe(0n);
  });

  it("rejects non-integer versions like Go's strconv.Atoi", () => {
    expect(legacyParseMigrationVersion("")).toBeUndefined();
    expect(legacyParseMigrationVersion("abc")).toBeUndefined();
    expect(legacyParseMigrationVersion(" 12")).toBeUndefined();
    expect(legacyParseMigrationVersion("1.0")).toBeUndefined();
    expect(legacyParseMigrationVersion("0x10")).toBeUndefined();
    expect(legacyParseMigrationVersion("+")).toBeUndefined();
  });

  it("accepts a leading +/- sign like strconv.Atoi (for malformed history rows)", () => {
    // Go's `Atoi` == `ParseInt(s, 10, 0)` accepts a leading sign, so `migration repair -1`
    // can delete a malformed `-1` row and the two-pointer merge orders `-1` before `0`.
    expect(legacyParseMigrationVersion("-1")).toBe(-1n);
    expect(legacyParseMigrationVersion("+5")).toBe(5n);
  });

  it("accepts the full int64 range but rejects values outside it", () => {
    // 16 digits Go accepts and surfaces as a conflict — must NOT be skipped.
    expect(legacyParseMigrationVersion("9999999999999999")).toBe(9999999999999999n);
    // int64 max/min parse; one beyond either bound is rejected (Go's Atoi range error).
    expect(legacyParseMigrationVersion(LEGACY_MIGRATION_VERSION_MAX.toString())).toBe(
      LEGACY_MIGRATION_VERSION_MAX,
    );
    expect(
      legacyParseMigrationVersion((LEGACY_MIGRATION_VERSION_MAX + 1n).toString()),
    ).toBeUndefined();
    expect(legacyParseMigrationVersion("-9223372036854775808")).toBe(-9223372036854775808n);
    expect(legacyParseMigrationVersion("-9223372036854775809")).toBeUndefined();
  });
});
