import { describe, expect, it } from "vitest";
import { digestFileSet, digestUtf8, digestVersions } from "./schema-digest.ts";

describe("schema-digest", () => {
  it("is stable across file order", () => {
    expect(
      digestFileSet([
        { name: "b.sql", sql: "select 2" },
        { name: "a.sql", sql: "select 1" },
      ]),
    ).toBe(
      digestFileSet([
        { name: "a.sql", sql: "select 1" },
        { name: "b.sql", sql: "select 2" },
      ]),
    );
  });

  it("changes when content changes", () => {
    expect(digestFileSet([{ name: "a.sql", sql: "select 1" }])).not.toBe(
      digestFileSet([{ name: "a.sql", sql: "select 2" }]),
    );
  });

  it("hashes versions and utf8", () => {
    expect(digestVersions(["1", "2"])).toBe(digestUtf8("1\n2"));
  });
});
