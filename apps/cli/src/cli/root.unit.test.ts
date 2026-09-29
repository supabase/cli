import { describe, expect, it } from "vitest";
import { rootDescription } from "./root.ts";

describe("rootDescription", () => {
  it("leaves stable releases unlabeled", () => {
    expect(rootDescription("3.0.0")).toBe("Supabase CLI.");
  });

  it.each([
    ["3.0.0-beta.12", "Supabase CLI (beta channel)."],
    ["0.0.0-pr.1234", "Supabase CLI (preview build)."],
    ["0.0.0-dev", "Supabase CLI (development build)."],
    ["0.0.0-automated", "Supabase CLI (development build)."],
  ])("labels %j as %j", (version, expected) => {
    expect(rootDescription(version)).toBe(expected);
  });
});
