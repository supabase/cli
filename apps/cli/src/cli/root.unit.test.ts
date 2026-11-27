import { describe, expect, it } from "vitest";
import { cliEntrypointForFeatures, rootDescription } from "./root.ts";

describe("rootDescription", () => {
  it("leaves stable releases unlabeled", () => {
    expect(rootDescription("3.0.0")).toBe("Supabase CLI.");
  });

  it.each([
    ["3.0.0-beta.12", "Supabase CLI (beta channel)."],
    ["3.0.0-next.4", "Supabase CLI (next channel)."],
    ["0.0.0-pr.1234", "Supabase CLI (preview build)."],
    ["0.0.0-dev", "Supabase CLI (development build)."],
    ["0.0.0-automated", "Supabase CLI (development build)."],
  ])("labels %j as %j", (version, expected) => {
    expect(rootDescription(version)).toBe(expected);
  });
});

describe("cliEntrypointForFeatures agent default", () => {
  it.each([
    [["skill", "display", "overview"], "text"],
    [["--debug", "skill", "display", "--workdir", "/tmp/app"], "text"],
    [["skill", "list"], "json"],
    [["db", "push"], "json"],
  ] as const)("resolves %j to %s", (args, expected) => {
    expect(cliEntrypointForFeatures({}, args).agentDefaultOutputFormat).toBe(expected);
  });
});
