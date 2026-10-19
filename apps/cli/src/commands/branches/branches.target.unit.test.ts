import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { branchesSafeFlags } from "./branches.target.ts";

describe("branchesSafeFlags", () => {
  it("reports --project-ref when it is a project ref", () => {
    expect(branchesSafeFlags({ projectRef: Option.some("abcdefghijklmnopqrst") })).toEqual([
      "project-ref",
    ]);
  });

  it("withholds a --project-ref value that is a branch name", () => {
    expect(branchesSafeFlags({ projectRef: Option.some("feature-x") })).toEqual([]);
  });

  it("reports nothing without --project-ref", () => {
    expect(branchesSafeFlags({ projectRef: Option.none() })).toEqual([]);
  });
});
