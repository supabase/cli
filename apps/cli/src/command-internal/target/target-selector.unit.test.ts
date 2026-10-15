import { Option, Result } from "effect";
import { describe, expect, it } from "vitest";

import { parseTargetSelector, type TargetSelectorInput } from "./target-selector.ts";

const none: TargetSelectorInput = {
  local: false,
  linked: false,
  dbUrl: Option.none(),
  projectRef: Option.none(),
};

const parse = (overrides: Partial<TargetSelectorInput>) =>
  parseTargetSelector({ ...none, ...overrides });

const failure = (overrides: Partial<TargetSelectorInput>) => {
  const result = parse(overrides);
  if (Result.isSuccess(result)) throw new Error("expected the selector to be rejected");
  return result.failure;
};

describe("parseTargetSelector", () => {
  it("reports no explicit target when nothing is set", () => {
    expect(parse({})).toEqual(Result.succeed({ explicit: undefined }));
  });

  it.each([
    ["--local", { local: true }, { explicit: "local" }],
    ["--linked", { linked: true }, { explicit: "linked", projectRef: Option.none() }],
    [
      "--db-url",
      { dbUrl: Option.some("postgresql://u:p@db.example.com:5432/postgres") },
      { explicit: "db-url", url: "postgresql://u:p@db.example.com:5432/postgres" },
    ],
  ] as const)("selects the target named by %s", (_flag, overrides, expected) => {
    expect(parse(overrides)).toEqual(Result.succeed(expected));
  });

  it("treats false switches as absent, so --local=false and --linked=false select nothing", () => {
    expect(parse({ local: false, linked: false })).toEqual(Result.succeed({ explicit: undefined }));
  });

  it("lets a false switch coexist with another selector", () => {
    expect(parse({ linked: false, dbUrl: Option.some("postgresql://h/db") })).toEqual(
      Result.succeed({ explicit: "db-url", url: "postgresql://h/db" }),
    );
  });

  describe("--project-ref", () => {
    it("implies the linked target and carries the ref", () => {
      expect(parse({ projectRef: Option.some("abcdefghijklmnopqrst") })).toEqual(
        Result.succeed({ explicit: "linked", projectRef: Option.some("abcdefghijklmnopqrst") }),
      );
    });

    it("agrees with an explicit --linked", () => {
      expect(parse({ linked: true, projectRef: Option.some("abcdefghijklmnopqrst") })).toEqual(
        Result.succeed({ explicit: "linked", projectRef: Option.some("abcdefghijklmnopqrst") }),
      );
    });

    it("is rejected with --local", () => {
      expect(
        failure({ local: true, projectRef: Option.some("abcdefghijklmnopqrst") }),
      ).toMatchObject({
        _tag: "TargetProjectRefConflictError",
        conflictsWith: "--local",
        message: "--project-ref selects a linked project and cannot be combined with --local.",
      });
    });

    it("is rejected with --db-url", () => {
      expect(
        failure({
          dbUrl: Option.some("postgresql://h/db"),
          projectRef: Option.some("abcdefghijklmnopqrst"),
        }),
      ).toMatchObject({
        _tag: "TargetProjectRefConflictError",
        conflictsWith: "--db-url",
      });
    });

    it("is not rejected with --local=false", () => {
      expect(parse({ local: false, projectRef: Option.some("abcdefghijklmnopqrst") })).toEqual(
        Result.succeed({ explicit: "linked", projectRef: Option.some("abcdefghijklmnopqrst") }),
      );
    });
  });

  describe("mutual exclusion", () => {
    it("rejects --local with --linked and names both flags", () => {
      expect(failure({ local: true, linked: true })).toMatchObject({
        _tag: "TargetSelectorConflictError",
        flags: ["--local", "--linked"],
        message: "Only one of --local, --linked and --db-url can be set; got --local and --linked.",
      });
    });

    it("rejects --local with --db-url", () => {
      expect(failure({ local: true, dbUrl: Option.some("postgresql://h/db") })).toMatchObject({
        _tag: "TargetSelectorConflictError",
        flags: ["--local", "--db-url"],
      });
    });

    it("rejects --linked with --db-url", () => {
      expect(failure({ linked: true, dbUrl: Option.some("postgresql://h/db") })).toMatchObject({
        _tag: "TargetSelectorConflictError",
        flags: ["--linked", "--db-url"],
      });
    });

    it("lists all three flags when every selector is set", () => {
      expect(
        failure({ local: true, linked: true, dbUrl: Option.some("postgresql://h/db") }),
      ).toMatchObject({
        _tag: "TargetSelectorConflictError",
        flags: ["--local", "--linked", "--db-url"],
        message:
          "Only one of --local, --linked and --db-url can be set; got --local, --linked and --db-url.",
      });
    });

    it("reports the selector conflict before the --project-ref conflict", () => {
      expect(
        failure({ local: true, linked: true, projectRef: Option.some("abcdefghijklmnopqrst") }),
      ).toMatchObject({ _tag: "TargetSelectorConflictError" });
    });
  });

  describe("empty values", () => {
    it("rejects an empty --db-url", () => {
      expect(failure({ dbUrl: Option.some("") })).toMatchObject({
        _tag: "TargetEmptyValueError",
        flag: "--db-url",
        message: "--db-url cannot be empty.",
      });
    });

    it("rejects an empty --project-ref instead of treating it as a branch name", () => {
      expect(failure({ projectRef: Option.some("") })).toMatchObject({
        _tag: "TargetEmptyValueError",
        flag: "--project-ref",
        message: "--project-ref cannot be empty.",
      });
    });

    it("reports an empty value before any conflict", () => {
      expect(failure({ local: true, dbUrl: Option.some("") })).toMatchObject({
        _tag: "TargetEmptyValueError",
        flag: "--db-url",
      });
    });
  });
});
