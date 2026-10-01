import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runUpgradeNotice, upgradeNoticeHook } from "./upgrade-notice.ts";

describe("upgrade notice user-level cache", () => {
  let root: string;
  let workdir: string;
  let supabaseHome: string;
  let cacheFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "supabase-upgrade-notice-home-"));
    workdir = join(root, "outside-project");
    supabaseHome = join(root, "supabase-home");
    cacheFile = join(supabaseHome, "cli-latest");
    mkdirSync(workdir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeUserCache(tag: string, ageMs: number) {
    mkdirSync(supabaseHome, { recursive: true });
    writeFileSync(cacheFile, tag);
    const then = new Date(Date.now() - ageMs);
    utimesSync(cacheFile, then, then);
  }

  /** Runs the production hook with real `SUPABASE_HOME` resolution, capturing stderr. */
  async function runHook(args: ReadonlyArray<string>): Promise<string> {
    const written: Array<string> = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    const realEnv = {
      SUPABASE_HOME: process.env["SUPABASE_HOME"],
      SUPABASE_NO_UPDATE_NOTIFIER: process.env["SUPABASE_NO_UPDATE_NOTIFIER"],
    };
    process.env["SUPABASE_HOME"] = supabaseHome;
    process.env["SUPABASE_NO_UPDATE_NOTIFIER"] = "0";
    process.stderr.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await Effect.runPromise(
        upgradeNoticeHook(args, {
          cleanShowHelp: false,
          delegatedToGo: false,
          workingDirectory: workdir,
          isValueTakingFlagToken: () => false,
        }),
      );
    } finally {
      process.stderr.write = realWrite;
      for (const [key, value] of Object.entries(realEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    return stripVTControlCharacters(written.join(""));
  }

  it("serves a fresh SUPABASE_HOME cache outside a project without fetching", async () => {
    // A fetch from the hook would replace the cached tag, so an unchanged mtime proves none ran.
    writeUserCache("v99.99.99", 60_000);
    const mtimeBefore = statSync(cacheFile).mtimeMs;

    const stderr = await runHook(["projects", "list"]);

    expect(stderr).toContain("A new version of Supabase CLI is available: v99.99.99");
    expect(statSync(cacheFile).mtimeMs).toBe(mtimeBefore);
  });

  it("refetches a stale SUPABASE_HOME cache and records the new tag", async () => {
    writeUserCache("v2.100.0", 11 * 60 * 60 * 1000);
    let fetchCalls = 0;

    await runUpgradeNotice({
      env: {},
      args: ["projects", "list"],
      cwd: workdir,
      currentVersion: "2.113.0",
      supabaseHome,
      now: Date.now,
      fetchLatestTag: () => {
        fetchCalls += 1;
        return Promise.resolve("v2.114.0");
      },
      writeStderr: () => {},
    });

    expect(fetchCalls).toBe(1);
    expect(readFileSync(cacheFile, "utf8")).toBe("v2.114.0");
  });
});
