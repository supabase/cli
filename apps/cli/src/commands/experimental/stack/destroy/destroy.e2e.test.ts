import { describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

describe("stack destroy CLI surface", () => {
  test("rejects an invalid stack id through the compiled command wiring", () =>
    runSupabase(["--experimental", "stack", "destroy", "--yes", "--stack-id", "invalid"]).then(
      ({ exitCode, stdout, stderr }) => {
        expect(exitCode, `${stdout}\n${stderr}`).not.toBe(0);
        expect(`${stdout}\n${stderr}`).toContain("--stack-id must be a lowercase SHA-256 stack id");
      },
    ));
});
