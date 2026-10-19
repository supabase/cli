import { describe, expect, it } from "vitest";

import { classifyExplicitRef } from "./diff.explicit.ts";

const REF = "abcdefghijklmnopqrst";
const UUID = "11111111-2222-4333-8444-555555555555";

describe("classifyExplicitRef", () => {
  it.each([
    { value: "local", expected: { _tag: "Local" } },
    { value: "migrations", expected: { _tag: "Migrations" } },
    { value: "remote", expected: { _tag: "Remote", viaDeprecatedLinked: false } },
    { value: "linked", expected: { _tag: "Remote", viaDeprecatedLinked: true } },
  ])("reads the keyword $value", ({ value, expected }) => {
    expect(classifyExplicitRef(value)).toEqual(expected);
  });

  it.each([
    { value: REF, expected: { _tag: "Ref", ref: REF } },
    {
      value: "postgres://u:p@h:5432/db",
      expected: { _tag: "DbUrl", url: "postgres://u:p@h:5432/db" },
    },
    { value: "postgresql://u@h/db", expected: { _tag: "DbUrl", url: "postgresql://u@h/db" } },
    { value: "feature-x", expected: { _tag: "Branch", name: "feature-x" } },
    { value: UUID, expected: { _tag: "Branch", name: UUID } },
  ])("classifies $value like a --remote value", ({ value, expected }) => {
    expect(classifyExplicitRef(value)).toEqual(expected);
  });

  it.each(["host=h password=x", "dbname=postgres", "password=x"])(
    "keeps the keyword connection string %s apart from a branch name",
    (value) => {
      expect(classifyExplicitRef(value)).toEqual({ _tag: "KeywordDsn" });
    },
  );

  it("reaches a branch named like a keyword through its UUID, not the keyword", () => {
    expect(classifyExplicitRef("Remote")).toEqual({ _tag: "Branch", name: "Remote" });
    expect(classifyExplicitRef(UUID)).toEqual({ _tag: "Branch", name: UUID });
  });
});
