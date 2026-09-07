import { describe, expect, it } from "vitest";

import { legacyFailsOn, makeLegacyLevelEnum } from "./legacy-fail-on.ts";

describe("makeLegacyLevelEnum (prefix matcher — db lint)", () => {
  const lint = makeLegacyLevelEnum(["warning", "error"], "prefix");

  it("maps canonical levels to their ordinal", () => {
    expect(lint.toEnum("warning")).toBe(0);
    expect(lint.toEnum("error")).toBe(1);
  });

  it("matches on prefix so plpgsql_check's 'warning extra' resolves to warning", () => {
    expect(lint.toEnum("warning extra")).toBe(0);
  });

  it("returns -1 for an unknown level", () => {
    expect(lint.toEnum("none")).toBe(-1);
    expect(lint.toEnum("debug")).toBe(-1);
  });
});

describe("makeLegacyLevelEnum (exact-ci matcher — db advisors)", () => {
  const advisors = makeLegacyLevelEnum(["info", "warn", "error"], "exact-ci");

  it("matches the lower-case flag form", () => {
    expect(advisors.toEnum("info")).toBe(0);
    expect(advisors.toEnum("warn")).toBe(1);
    expect(advisors.toEnum("error")).toBe(2);
  });

  it("matches the upper-case database form", () => {
    expect(advisors.toEnum("INFO")).toBe(0);
    expect(advisors.toEnum("WARN")).toBe(1);
    expect(advisors.toEnum("ERROR")).toBe(2);
  });

  it("does NOT match a mixed-case level (Go's switch is exact)", () => {
    expect(advisors.toEnum("Info")).toBe(-1);
    expect(advisors.toEnum("warning")).toBe(-1);
  });

  it("returns -1 for an unknown level", () => {
    expect(advisors.toEnum("none")).toBe(-1);
  });
});

describe("legacyFailsOn", () => {
  const advisors = makeLegacyLevelEnum(["info", "warn", "error"], "exact-ci");

  it("never triggers when the threshold is below 0 (fail-on none)", () => {
    expect(legacyFailsOn([{ level: "ERROR" }], (i) => i.level, -1, advisors)).toBe(false);
  });

  it("triggers when an item meets the threshold", () => {
    const items = [{ level: "WARN" }, { level: "ERROR" }];
    expect(legacyFailsOn(items, (i) => i.level, advisors.toEnum("error"), advisors)).toBe(true);
  });

  it("does not trigger when every item is below the threshold", () => {
    const items = [{ level: "WARN" }, { level: "INFO" }];
    expect(legacyFailsOn(items, (i) => i.level, advisors.toEnum("error"), advisors)).toBe(false);
  });

  it("treats an unknown item level as below every threshold", () => {
    const items = [{ level: "mystery" }];
    expect(legacyFailsOn(items, (i) => i.level, advisors.toEnum("info"), advisors)).toBe(false);
  });
});
