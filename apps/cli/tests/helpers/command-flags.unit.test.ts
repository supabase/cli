import { describe, expect, it } from "vitest";

import { commandTreeFor } from "./command-flags.ts";

describe("commandTreeFor", () => {
  const tree = commandTreeFor(undefined);

  it("gives a leaf its own flags and the root's global flags", () => {
    const flags = tree.get("db query")?.flags;
    expect(flags).toBeDefined();
    expect(flags).toContain("linked");
    expect(flags).toContain("output");
  });

  it("does not give a leaf a flag only some other command accepts", () => {
    expect(tree.get("db query")?.flags).not.toContain("password");
  });

  it("marks a group as a non-leaf and its subcommand as a leaf", () => {
    expect(tree.get("db")?.isLeaf).toBe(false);
    expect(tree.get("db query")?.isLeaf).toBe(true);
  });

  it("only includes feature-gated commands for the variant that enables them", () => {
    expect(tree.has("compute list")).toBe(false);
    expect(commandTreeFor({ computeEnabled: true }).has("compute list")).toBe(true);
  });
});
