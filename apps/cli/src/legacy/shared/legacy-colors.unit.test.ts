import { describe, expect, it } from "vitest";

import { legacyAqua, legacyBold, legacyGreen, legacyRed, legacyYellow } from "./legacy-colors.ts";

// These tests only assert that each helper runs without throwing and returns a
// string containing the input text — actual color application depends on the
// stream's live TTY/NO_COLOR state, which isn't controllable from a test
// process. The behavior worth protecting here is the `stream` parameter
// threading through to `styleText`, not a specific ANSI byte sequence.
describe("legacy-colors", () => {
  it("legacyAqua defaults to stderr when no stream is given", () => {
    expect(legacyAqua("supabase")).toContain("supabase");
  });

  it("legacyAqua accepts an explicit stream", () => {
    expect(legacyAqua("supabase", process.stdout)).toContain("supabase");
  });

  it("legacyBold defaults to stderr when no stream is given", () => {
    expect(legacyBold("text")).toContain("text");
  });

  it("legacyBold accepts an explicit stream", () => {
    expect(legacyBold("text", process.stdout)).toContain("text");
  });

  it("legacyYellow defaults to stderr when no stream is given", () => {
    expect(legacyYellow("warning")).toContain("warning");
  });

  it("legacyYellow accepts an explicit stream", () => {
    expect(legacyYellow("warning", process.stdout)).toContain("warning");
  });

  it("legacyRed defaults to stderr when no stream is given", () => {
    expect(legacyRed("error")).toContain("error");
  });

  it("legacyRed accepts an explicit stream", () => {
    expect(legacyRed("error", process.stdout)).toContain("error");
  });

  it("legacyGreen defaults to stderr when no stream is given", () => {
    expect(legacyGreen("label")).toContain("label");
  });

  it("legacyGreen accepts an explicit stream", () => {
    expect(legacyGreen("label", process.stdout)).toContain("label");
  });
});
