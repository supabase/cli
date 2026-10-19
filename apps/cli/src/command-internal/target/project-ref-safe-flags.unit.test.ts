import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { projectRefSafeFlags } from "./project-ref-safe-flags.ts";

const REF = "abcdefghijklmnopqrst";

describe("projectRefSafeFlags", () => {
  it("reports --project-ref when it is a project ref", () => {
    expect(projectRefSafeFlags({ projectRef: Option.some(REF) })).toEqual(["project-ref"]);
  });

  it("withholds a --project-ref value that is a branch name", () => {
    expect(projectRefSafeFlags({ projectRef: Option.some("feature-x") })).toEqual([]);
  });

  it("reports nothing without --project-ref", () => {
    expect(projectRefSafeFlags({ projectRef: Option.none() })).toEqual([]);
  });

  it("applies the same rule to --project-id", () => {
    expect(projectRefSafeFlags({ projectRef: Option.none(), projectId: Option.some(REF) })).toEqual(
      ["project-id"],
    );
    expect(
      projectRefSafeFlags({ projectRef: Option.none(), projectId: Option.some("feature-x") }),
    ).toEqual([]);
  });

  it("reports both flags when both are ref-shaped", () => {
    expect(
      projectRefSafeFlags({ projectRef: Option.some(REF), projectId: Option.some(REF) }),
    ).toEqual(["project-ref", "project-id"]);
  });
});
