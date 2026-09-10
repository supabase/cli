import { expect } from "vitest";
import { test } from "../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 60_000;

// Exercises the full live path — built binary, profile resolution, authenticated Management
// API request — with a read-only call that's safe to rerun and creates no resources.
test(
  "lists organizations for the authenticated token",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ cli }) => {
    const { exitCode, stdout, stderr } = await cli(["orgs", "list", "--output", "json"]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout), stderr).not.toHaveLength(0);
  },
);
