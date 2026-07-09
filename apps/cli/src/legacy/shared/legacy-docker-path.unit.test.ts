import { describe, expect, test } from "vitest";

import { legacyToDockerPath } from "./legacy-docker-path.ts";

describe("legacyToDockerPath", () => {
  test("leaves a posix path unchanged", () => {
    expect(legacyToDockerPath("/work/project/supabase/tests")).toBe("/work/project/supabase/tests");
  });

  test("strips a Windows volume and converts backslashes", () => {
    expect(legacyToDockerPath("C:\\Users\\me\\tests\\a_test.sql")).toBe(
      "/Users/me/tests/a_test.sql",
    );
  });
});
