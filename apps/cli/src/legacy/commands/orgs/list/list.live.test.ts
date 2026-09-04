import { expect } from "vitest";
import { test } from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 60_000;

// Harness smoke for the live Vitest project: the canonical example of a live
// test. It exercises the full path — built binary → temporary profile resolution
// → authenticated Management API request against the running platform — with a
// read-only call, so it is safe to run repeatedly and creates no resources.
//
test(
  "lists organizations for the authenticated token",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ cli }) => {
    const { exitCode, stdout, stderr } = await cli(["orgs", "list"]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout, stderr).toMatch(/ID\s+\|\s+NAME/);
    const orgs = stdout
      .split("\n")
      .filter((line) => line.includes("|"))
      .slice(2);
    expect(orgs, stdout).not.toHaveLength(0);
  },
);
