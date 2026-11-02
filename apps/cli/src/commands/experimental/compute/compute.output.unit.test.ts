import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { computeRemoteSuffix } from "./compute.output.ts";

const REF = "abcdefghijklmnopqrst";
const none = { remote: Option.none(), projectRef: Option.none() } as const;

describe("computeRemoteSuffix", () => {
  it("carries an explicit --remote=<ref> into the suggestion", () => {
    expect(
      computeRemoteSuffix({ ...none, remote: Option.some({ _tag: "Ref", ref: REF }) }, REF),
    ).toBe(` --remote=${REF}`);
  });

  it("carries the deprecated --project-ref as --remote=<ref>", () => {
    expect(computeRemoteSuffix({ ...none, projectRef: Option.some(REF) }, REF)).toBe(
      ` --remote=${REF}`,
    );
  });

  it("carries a branch as the ref it resolved to", () => {
    expect(
      computeRemoteSuffix(
        { ...none, remote: Option.some({ _tag: "Branch", name: "staging" }) },
        REF,
      ),
    ).toBe(` --remote=${REF}`);
  });

  it("adds nothing when the ref came from the link", () => {
    expect(computeRemoteSuffix(none, REF)).toBe("");
  });

  it("adds nothing for a bare --remote, which names the linked project", () => {
    expect(computeRemoteSuffix({ ...none, remote: Option.some({ _tag: "Linked" }) }, REF)).toBe("");
  });
});
