import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { computeProjectRefSuffix } from "./compute.output.ts";

describe("computeProjectRefSuffix", () => {
  it("carries an explicit --project-ref into the suggestion", () => {
    expect(computeProjectRefSuffix(Option.some("abcdefghijklmnopqrst"))).toBe(
      " --project-ref abcdefghijklmnopqrst",
    );
  });

  it("adds nothing when the ref came from the link", () => {
    expect(computeProjectRefSuffix(Option.none())).toBe("");
  });

  // `--project-ref ""` resolves from the environment or the linked-project file,
  // so echoing the flag back would suggest a command ending in a valueless
  // `--project-ref` that cannot be pasted and re-run.
  it("adds nothing when the flag was supplied empty", () => {
    expect(computeProjectRefSuffix(Option.some(""))).toBe("");
  });
});
