import { describe, expect, it } from "vitest";
import {
  alignConfigPostgresMajor,
  formatShadowMajorAlignedMessage,
  generateLocalShadowBanner,
  parseConfigPostgresMajor,
  parsePostgresMajor,
} from "./remote-postgres.ts";

describe("parsePostgresMajor", () => {
  it("reads the leading major from SHOW server_version", () => {
    expect(parsePostgresMajor("17.6")).toBe(17);
    expect(parsePostgresMajor("15.8 (Ubuntu 15.8-1)")).toBe(15);
    expect(parsePostgresMajor(undefined)).toBeUndefined();
    expect(parsePostgresMajor("")).toBeUndefined();
  });
});

describe("parseConfigPostgresMajor", () => {
  it("reads the first major_version assignment", () => {
    expect(parseConfigPostgresMajor("[db]\nmajor_version = 15\n")).toBe(15);
    expect(parseConfigPostgresMajor('project_id = "x"\n')).toBeUndefined();
  });
});

describe("alignConfigPostgresMajor", () => {
  it("rewrites a differing major_version and leaves matching config alone", () => {
    const aligned = alignConfigPostgresMajor("[db]\nmajor_version = 15\n", 17);
    expect(aligned).toEqual({
      previousMajor: 15,
      toml: "[db]\nmajor_version = 17\n",
    });
    expect(alignConfigPostgresMajor("[db]\nmajor_version = 17\n", 17)).toBeUndefined();
    expect(alignConfigPostgresMajor('project_id = "x"\n', 17)).toBeUndefined();
  });
});

describe("formatShadowMajorAlignedMessage", () => {
  it("sends the running local container to db reset", () => {
    expect(formatShadowMajorAlignedMessage(17, 15)).toBe(
      "Shadow major is now 17 (was 15). The running local database is still 15. Next: supabase db reset",
    );
  });
});

describe("generateLocalShadowBanner", () => {
  it("names a local shadow, not the linked project", () => {
    expect(generateLocalShadowBanner(15)).toBe(
      "Compared declarations vs migration replay on a local PG 15 shadow, not the linked project.",
    );
    expect(generateLocalShadowBanner(undefined)).toContain("local Postgres shadow");
    expect(generateLocalShadowBanner(undefined)).toContain("not the linked project");
  });
});
