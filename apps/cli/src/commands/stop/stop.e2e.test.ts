import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeTempHome, runSupabase } from "../../../tests/helpers/cli.ts";

const LIGHTWEIGHT_START_ARGS = [
  "start",
  "--detach",
  "--exclude",
  "realtime",
  "--exclude",
  "storage",
  "--exclude",
  "imgproxy",
  "--exclude",
  "mailpit",
  "--exclude",
  "pgmeta",
  "--exclude",
  "studio",
  "--exclude",
  "analytics",
  "--exclude",
  "vector",
  "--exclude",
  "pooler",
] as const;

describe("supabase stop", () => {
  test("shows a friendly error when no local stack is running", async () => {
    const { stdout, stderr, exitCode } = await runSupabase(["stop"]);
    const output = `${stdout}${stderr}`;

    expect(exitCode).toBe(1);
    expect(output).toContain("No local Supabase stack is running for this project.");
    expect(output).toContain("Run `supabase start` in this project");
    expect(output).not.toContain("NoRunningStackError:");
    expect(output).not.toContain("StateManager.ts:");
  });

  test("preserves the persisted stack folder by default", async () => {
    const home = makeTempHome();
    const stackDir = join(home.dir, "stacks", "cli");

    try {
      const startResult = await runSupabase([...LIGHTWEIGHT_START_ARGS], { home: home.dir });
      expect(startResult.exitCode).toBe(0);

      const stopResult = await runSupabase(["stop"], { home: home.dir });
      expect(stopResult.exitCode).toBe(0);
      expect(existsSync(stackDir)).toBe(true);
      expect(existsSync(join(stackDir, "ports.json"))).toBe(true);
      expect(existsSync(join(stackDir, "state.json"))).toBe(false);
    } finally {
      await runSupabase(["stop", "--no-backup"], { home: home.dir }).catch(() => {});
      home[Symbol.dispose]();
    }
  });

  test("deletes the persisted stack folder with --no-backup", async () => {
    const home = makeTempHome();
    const stackDir = join(home.dir, "stacks", "cli");

    try {
      const startResult = await runSupabase([...LIGHTWEIGHT_START_ARGS], { home: home.dir });
      expect(startResult.exitCode).toBe(0);

      const stopResult = await runSupabase(["stop", "--no-backup"], { home: home.dir });
      expect(stopResult.exitCode).toBe(0);
      expect(existsSync(stackDir)).toBe(false);
    } finally {
      await runSupabase(["stop", "--no-backup"], { home: home.dir }).catch(() => {});
      home[Symbol.dispose]();
    }
  });

  test("deletes persisted stack data with --no-backup after a prior plain stop", async () => {
    const home = makeTempHome();
    const stackDir = join(home.dir, "stacks", "cli");

    try {
      const startResult = await runSupabase([...LIGHTWEIGHT_START_ARGS], { home: home.dir });
      expect(startResult.exitCode).toBe(0);

      const firstStop = await runSupabase(["stop"], { home: home.dir });
      expect(firstStop.exitCode).toBe(0);
      expect(existsSync(stackDir)).toBe(true);

      const secondStop = await runSupabase(["stop", "--no-backup"], { home: home.dir });
      expect(secondStop.exitCode).toBe(0);
      expect(existsSync(stackDir)).toBe(false);
    } finally {
      await runSupabase(["stop", "--no-backup"], { home: home.dir }).catch(() => {});
      home[Symbol.dispose]();
    }
  });

  test("shows the same friendly error for --no-backup when nothing exists", async () => {
    const { stdout, stderr, exitCode } = await runSupabase(["stop", "--no-backup"]);
    const output = `${stdout}${stderr}`;

    expect(exitCode).toBe(1);
    expect(output).toContain("No local Supabase stack is running for this project.");
    expect(output).toContain("Run `supabase start` in this project");
    expect(output).not.toContain("NoRunningStackError:");
  });
});
