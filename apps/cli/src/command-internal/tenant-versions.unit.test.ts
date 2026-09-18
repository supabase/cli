import { describe, expect, it } from "vitest";
import { Option } from "effect";

import {
  parseGotrueVersion,
  parsePostgrestVersion,
  parseStorageVersion,
} from "./tenant-versions.ts";

describe("parsePostgrestVersion", () => {
  it("prefixes the first token of info.version with v", () => {
    expect(parsePostgrestVersion({ info: { version: "12.2.0" } })).toEqual(Option.some("v12.2.0"));
  });

  it("uses only the first whitespace-delimited field (Go strings.Fields)", () => {
    expect(parsePostgrestVersion({ info: { version: "12.2.0 (abc123)" } })).toEqual(
      Option.some("v12.2.0"),
    );
  });

  it("returns None when info.version is empty or missing", () => {
    expect(Option.isNone(parsePostgrestVersion({ info: { version: "" } }))).toBe(true);
    expect(Option.isNone(parsePostgrestVersion({ info: {} }))).toBe(true);
    expect(Option.isNone(parsePostgrestVersion({}))).toBe(true);
    expect(Option.isNone(parsePostgrestVersion(null))).toBe(true);
  });
});

describe("parseGotrueVersion", () => {
  it("returns the version verbatim (no v prefix)", () => {
    expect(parseGotrueVersion({ version: "v2.151.0" })).toEqual(Option.some("v2.151.0"));
    expect(parseGotrueVersion({ version: "2.151.0" })).toEqual(Option.some("2.151.0"));
  });

  it("returns None when version is empty or missing", () => {
    expect(Option.isNone(parseGotrueVersion({ version: "" }))).toBe(true);
    expect(Option.isNone(parseGotrueVersion({}))).toBe(true);
    expect(Option.isNone(parseGotrueVersion(null))).toBe(true);
  });
});

describe("parseStorageVersion", () => {
  it("prefixes the body with v", () => {
    expect(parseStorageVersion("1.19.3")).toEqual(Option.some("v1.19.3"));
  });

  it("treats empty body and 0.0.0 sentinel as not found", () => {
    expect(Option.isNone(parseStorageVersion(""))).toBe(true);
    expect(Option.isNone(parseStorageVersion("0.0.0"))).toBe(true);
  });
});
