import { describe, expect, test } from "vitest";

import { toDockerMountPath } from "./docker-path.ts";

describe("toDockerMountPath", () => {
  test("leaves a posix path unchanged", () => {
    expect(toDockerMountPath("/work/project/supabase/tests")).toBe("/work/project/supabase/tests");
  });

  test("strips a Windows volume and converts backslashes", () => {
    expect(toDockerMountPath("C:\\Users\\me\\tests\\a_test.sql")).toBe(
      "/Users/me/tests/a_test.sql",
    );
  });
});
