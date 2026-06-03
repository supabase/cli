import { describe, expect, it } from "vitest";
import { Option } from "effect";

import {
  parseLegacyGotrueVersion,
  parseLegacyPostgrestVersion,
  parseLegacyStorageVersion,
} from "./legacy-tenant-versions.ts";

describe("parseLegacyPostgrestVersion", () => {
  it("prefixes the first token of info.version with v", () => {
    expect(parseLegacyPostgrestVersion({ info: { version: "12.2.0" } })).toEqual(
      Option.some("v12.2.0"),
    );
  });

  it("uses only the first whitespace-delimited field (Go strings.Fields)", () => {
    expect(parseLegacyPostgrestVersion({ info: { version: "12.2.0 (abc123)" } })).toEqual(
      Option.some("v12.2.0"),
    );
  });

  it("returns None when info.version is empty or missing", () => {
    expect(Option.isNone(parseLegacyPostgrestVersion({ info: { version: "" } }))).toBe(true);
    expect(Option.isNone(parseLegacyPostgrestVersion({ info: {} }))).toBe(true);
    expect(Option.isNone(parseLegacyPostgrestVersion({}))).toBe(true);
    expect(Option.isNone(parseLegacyPostgrestVersion(null))).toBe(true);
  });
});

describe("parseLegacyGotrueVersion", () => {
  it("returns the version verbatim (no v prefix)", () => {
    expect(parseLegacyGotrueVersion({ version: "v2.151.0" })).toEqual(Option.some("v2.151.0"));
    expect(parseLegacyGotrueVersion({ version: "2.151.0" })).toEqual(Option.some("2.151.0"));
  });

  it("returns None when version is empty or missing", () => {
    expect(Option.isNone(parseLegacyGotrueVersion({ version: "" }))).toBe(true);
    expect(Option.isNone(parseLegacyGotrueVersion({}))).toBe(true);
    expect(Option.isNone(parseLegacyGotrueVersion(null))).toBe(true);
  });
});

describe("parseLegacyStorageVersion", () => {
  it("prefixes the body with v", () => {
    expect(parseLegacyStorageVersion("1.19.3")).toEqual(Option.some("v1.19.3"));
  });

  it("treats empty body and 0.0.0 sentinel as not found", () => {
    expect(Option.isNone(parseLegacyStorageVersion(""))).toBe(true);
    expect(Option.isNone(parseLegacyStorageVersion("0.0.0"))).toBe(true);
  });
});
