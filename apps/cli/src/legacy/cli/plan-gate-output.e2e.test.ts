import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";
import { runSupabase, stripAnsi } from "../../../tests/helpers/cli.ts";

function parseJsonLines(output: string): Array<unknown> {
  return stripAnsi(output)
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function gatedEnvelope(feature: string) {
  return {
    message: "This feature requires a paid plan",
    error: {
      code: "entitlement_required",
      feature,
      upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
    },
  };
}

async function withGatedApiStub<T>(
  feature: string,
  run: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json(gatedEnvelope(feature), { status: 403 }),
  });
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "supabase-e2e-profile-"));
  const profilePath = path.join(profileDir, "profile.yaml");
  await fs.writeFile(profilePath, `api_url: http://127.0.0.1:${server.port}\n`);

  try {
    return await run({
      SUPABASE_PROFILE: profilePath,
      SUPABASE_ACCESS_TOKEN: `sbp_${"a".repeat(40)}`,
    });
  } finally {
    server.stop(true);
    await fs.rm(profileDir, { recursive: true, force: true });
  }
}

describe("legacy CLI plan-gate error output", () => {
  test("carries entitlement on the JSON error for a gated denial", async () => {
    await withGatedApiStub("physical_backups", async (env) => {
      const result = await runSupabase(
        ["backups", "list", "--project-ref", "abcdefghijklmnopqrst", "--output-format", "json"],
        { entrypoint: "legacy", env },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toContain("Upgrade your plan:");
      expect(parseJsonLines(result.stdout)).toEqual([
        expect.objectContaining({
          _tag: "Error",
          error: expect.objectContaining({
            entitlement: {
              feature: "physical_backups",
              upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
            },
            suggestion: expect.stringContaining(
              "https://supabase.com/dashboard/org/env-org/billing",
            ),
          }),
        }),
      ]);
    });
  });

  test("prints the text-mode hint exactly once for a gated denial with no per-command wiring", async () => {
    await withGatedApiStub("physical_backups", async (env) => {
      const result = await runSupabase(
        ["backups", "list", "--project-ref", "abcdefghijklmnopqrst"],
        {
          entrypoint: "legacy",
          env,
        },
      );
      expect(result.exitCode).not.toBe(0);
      const stderr = stripAnsi(result.stderr);
      expect(stderr.split("Upgrade your plan:").length - 1).toBe(1);
      expect(stderr.indexOf("Upgrade your plan:")).toBeLessThan(
        stderr.indexOf("unexpected list backup status 403"),
      );
      expect(stderr).toContain("Try rerunning the command with --debug");
    });
  });

  test("prints the hint exactly once for a previously per-site-wired gated command", async () => {
    await withGatedApiStub("custom_domain", async (env) => {
      const result = await runSupabase(
        ["domains", "get", "--project-ref", "abcdefghijklmnopqrst"],
        {
          entrypoint: "legacy",
          env,
        },
      );
      expect(result.exitCode).not.toBe(0);
      const stderr = stripAnsi(result.stderr);
      expect(stderr.split("Upgrade your plan:").length - 1).toBe(1);
      expect(stderr).toContain("unexpected get hostname status 403");
    });
  });
});
