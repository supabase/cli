// oxlint-disable effecttsgo/async-function -- this live test uses Vitest's Promise surface to drive the real CLI.
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
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
    expect(exitCode).toBe(0);
  },
);
