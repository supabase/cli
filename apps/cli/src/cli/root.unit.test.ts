import { describe, expect, it } from "vitest";
import { rootDescription } from "./root.ts";

describe("rootDescription", () => {
  it("leaves stable releases unlabeled", () => {
    expect(rootDescription("3.0.0")).toBe(
      "Develop locally and manage hosted Supabase projects from the terminal.",
    );
  });

  it.each([
    [
      "3.0.0-beta.12",
      "Develop locally and manage hosted Supabase projects from the terminal (beta channel).",
    ],
    [
      "3.0.0-next.4",
      "Develop locally and manage hosted Supabase projects from the terminal (next channel).",
    ],
    [
      "0.0.0-pr.1234",
      "Develop locally and manage hosted Supabase projects from the terminal (preview build).",
    ],
    [
      "0.0.0-dev",
      "Develop locally and manage hosted Supabase projects from the terminal (development build).",
    ],
    [
      "0.0.0-automated",
      "Develop locally and manage hosted Supabase projects from the terminal (development build).",
    ],
  ])("labels %j as %j", (version, expected) => {
    expect(rootDescription(version)).toBe(expected);
  });
});
