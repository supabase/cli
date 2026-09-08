import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { workersProjectRefSuffix } from "./workers.output.ts";

describe("workersProjectRefSuffix", () => {
  it("carries an explicit --project-ref into the suggestion", () => {
    expect(workersProjectRefSuffix(Option.some("abcdefghijklmnopqrst"))).toBe(
      " --project-ref abcdefghijklmnopqrst",
    );
  });

  it("adds nothing when the ref came from the link", () => {
    expect(workersProjectRefSuffix(Option.none())).toBe("");
  });

  // `--project-ref ""` resolves from the environment or the linked-project file,
  // so echoing the flag back would suggest a command ending in a valueless
  // `--project-ref` that cannot be pasted and re-run.
  it("adds nothing when the flag was supplied empty", () => {
    expect(workersProjectRefSuffix(Option.some(""))).toBe("");
  });
});
