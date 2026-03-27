import { describe, expect, test } from "vitest";
import { Cause } from "effect";
import { formatCliError, normalizeCause, normalizeCliError } from "./normalize-error.ts";

describe("normalizeCliError", () => {
  test("maps NoRunningStackError to a user-facing message", () => {
    const error = {
      _tag: "NoRunningStackError",
      cwd: "/tmp/project",
    };

    const normalized = normalizeCliError(error);

    expect(normalized).toEqual({
      code: "NoRunningStackError",
      message: "No local Supabase stack is running for this project.",
      detail: "The CLI could not find a running stack for the current working directory.",
      suggestion:
        "Run `supabase start` in this project, or change into a directory with a running stack.",
    });
  });

  test("falls back to tagged error fields when no explicit mapping exists", () => {
    const error = {
      _tag: "ExampleError",
      detail: "Something went wrong",
      suggestion: "Try again",
    };

    expect(normalizeCliError(error)).toEqual({
      code: "ExampleError",
      message: "Something went wrong",
      suggestion: "Try again",
    });
  });

  test("normalizes a cause via its first failure", () => {
    const normalized = normalizeCause(Cause.fail({ _tag: "NoRunningStackError", cwd: "/tmp" }));

    expect(normalized.message).toBe("No local Supabase stack is running for this project.");
  });

  test("formats text output with detail and suggestion", () => {
    const text = formatCliError({
      code: "NoRunningStackError",
      message: "No local Supabase stack is running for this project.",
      detail: "The CLI could not find a running stack for the current working directory.",
      suggestion:
        "Run `supabase start` in this project, or change into a directory with a running stack.",
    });

    expect(text).toContain("No local Supabase stack is running for this project.");
    expect(text).toContain(
      "Detail: The CLI could not find a running stack for the current working directory.",
    );
    expect(text).toContain(
      "Suggestion: Run `supabase start` in this project, or change into a directory with a running stack.",
    );
  });
});
