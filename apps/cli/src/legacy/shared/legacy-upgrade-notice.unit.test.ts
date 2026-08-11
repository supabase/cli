import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { describe, expect, it } from "vitest";

import {
  type LegacyUpgradeNoticeDeps,
  legacyFormatUpgradeNotice,
  legacyIsNewerCliVersion,
  legacyRunUpgradeNotice,
  legacyUpdateNotifierDisabled,
} from "./legacy-upgrade-notice.ts";

describe("legacyUpdateNotifierDisabled", () => {
  it.each(["1", "t", "T", "TRUE", "true", "True"])("suppresses for ParseBool-true %j", (value) => {
    expect(legacyUpdateNotifierDisabled(value)).toBe(true);
  });

  it.each([undefined, "", "0", "false", "FALSE", "f", "garbage", "yes", "on"])(
    "keeps the notifier enabled for %j",
    (value) => {
      expect(legacyUpdateNotifierDisabled(value)).toBe(false);
    },
  );
});

describe("legacyIsNewerCliVersion", () => {
  it.each([
    ["v2.114.0", "2.113.0", true],
    ["v2.113.1", "2.113.0", true],
    ["v3.0.0", "2.999.999", true],
    ["v2.113.0", "2.113.0", false],
    ["v2.112.9", "2.113.0", false],
    ["v2.114.0", "2.114.0-beta.1", true],
    ["v2.114.0-beta.1", "2.114.0", false],
    ["", "2.113.0", false],
    ["not-a-version", "2.113.0", false],
    // x/mod/semver requires the leading v: a bare tag is invalid to Go.
    ["2.114.0", "2.113.0", false],
    ["v2.114.0", "0.0.0-dev", true],
    ["v2.114.0", "", true],
    ["v2.114.0-beta.10", "2.114.0-beta.9", true],
    ["v2.114.0-beta.9", "2.114.0-beta.10", false],
    ["v2.114.0-rc.1", "2.114.0-beta.2", true],
    ["v2.114.0-beta.2", "2.114.0-beta.11", false],
  ])("latest %j vs current %j -> %s", (latest, current, expected) => {
    expect(legacyIsNewerCliVersion(latest, current)).toBe(expected);
  });
});

describe("legacyFormatUpgradeNotice", () => {
  it("matches the Go CLI's message bytes modulo styling", () => {
    expect(stripVTControlCharacters(legacyFormatUpgradeNotice("v2.114.0", "2.113.0"))).toBe(
      "A new version of Supabase CLI is available: v2.114.0 (currently installed v2.113.0)\n" +
        "We recommend updating regularly for new features and bug fixes: " +
        "https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli",
    );
  });
});

describe("legacyRunUpgradeNotice", () => {
  let workdir: string;

  function setup(opts: {
    readonly env?: Record<string, string>;
    readonly args?: ReadonlyArray<string>;
    readonly latestTag?: string;
    readonly fetchFails?: boolean;
    readonly project?: boolean;
    readonly cacheContent?: string;
    readonly cacheAgeMs?: number;
    readonly currentVersion?: string;
  }) {
    workdir = mkdtempSync(join(tmpdir(), "supabase-legacy-upgrade-notice-"));
    if (opts.project !== false) {
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "config.toml"), 'project_id = "demo"\n');
    }
    if (opts.cacheContent !== undefined) {
      mkdirSync(join(workdir, "supabase", ".temp"), { recursive: true });
      const cacheFile = join(workdir, "supabase", ".temp", "cli-latest");
      writeFileSync(cacheFile, opts.cacheContent);
      if (opts.cacheAgeMs !== undefined) {
        const then = new Date(Date.now() - opts.cacheAgeMs);
        utimesSync(cacheFile, then, then);
      }
    }
    let fetchCalls = 0;
    const stderr: Array<string> = [];
    const deps: LegacyUpgradeNoticeDeps = {
      env: opts.env ?? {},
      args: opts.args ?? ["db", "start"],
      cwd: workdir,
      currentVersion: opts.currentVersion ?? "2.113.0",
      now: Date.now,
      fetchLatestTag: () => {
        fetchCalls += 1;
        return opts.fetchFails === true
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(opts.latestTag ?? "v2.114.0");
      },
      writeStderr: (text) => {
        stderr.push(text);
      },
    };
    return {
      deps,
      get fetchCalls() {
        return fetchCalls;
      },
      get stderr() {
        return stripVTControlCharacters(stderr.join(""));
      },
      cachePath: join(workdir, "supabase", ".temp", "cli-latest"),
      cleanup: () => rmSync(workdir, { recursive: true, force: true }),
    };
  }

  it("prints the notice and caches the tag when a newer release exists", async () => {
    const ctx = setup({});
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.fetchCalls).toBe(1);
    expect(ctx.stderr).toContain("A new version of Supabase CLI is available: v2.114.0");
    expect(readFileSync(ctx.cachePath, "utf8")).toBe("v2.114.0");
    ctx.cleanup();
  });

  it("SUPABASE_NO_UPDATE_NOTIFIER=1 skips the fetch and the notice entirely", async () => {
    const ctx = setup({ env: { SUPABASE_NO_UPDATE_NOTIFIER: "1" } });
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.fetchCalls).toBe(0);
    expect(ctx.stderr).toBe("");
    ctx.cleanup();
  });

  it("stays silent when already on the latest release", async () => {
    const ctx = setup({ latestTag: "v2.113.0" });
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.stderr).toBe("");
    ctx.cleanup();
  });

  it("reads a fresh cache instead of fetching", async () => {
    const ctx = setup({ cacheContent: "v2.115.0", cacheAgeMs: 60_000 });
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.fetchCalls).toBe(0);
    expect(ctx.stderr).toContain("v2.115.0");
    ctx.cleanup();
  });

  it("refetches when the cache is older than ten hours", async () => {
    const ctx = setup({ cacheContent: "v2.115.0", cacheAgeMs: 11 * 60 * 60 * 1000 });
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.fetchCalls).toBe(1);
    expect(readFileSync(ctx.cachePath, "utf8")).toBe("v2.114.0");
    ctx.cleanup();
  });

  it("--version forces a fetch through a fresh cache", async () => {
    const ctx = setup({ args: ["--version"], cacheContent: "v2.115.0", cacheAgeMs: 60_000 });
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.fetchCalls).toBe(1);
    ctx.cleanup();
  });

  it("SUPABASE_DEBUG surfaces fetch failures without the --debug flag, like viper's AutomaticEnv", async () => {
    const ctx = setup({ fetchFails: true, project: false, env: { SUPABASE_DEBUG: "1" } });
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.stderr).toContain("Failed to fetch latest release");
    ctx.cleanup();
  });

  it("--debug=true surfaces fetch failures and --debug=false silences them, like pflag", async () => {
    const on = setup({ fetchFails: true, project: false, args: ["db", "start", "--debug=true"] });
    await legacyRunUpgradeNotice(on.deps);
    expect(on.stderr).toContain("Failed to fetch latest release");
    on.cleanup();

    // A set flag (`--debug=false`) beats SUPABASE_DEBUG, like viper.
    const off = setup({
      fetchFails: true,
      project: false,
      args: ["db", "start", "--debug=false"],
      env: { SUPABASE_DEBUG: "1" },
    });
    await legacyRunUpgradeNotice(off.deps);
    expect(off.stderr).toBe("");
    off.cleanup();
  });

  it("a built-in ignores SUPABASE_DEBUG but still honors the --debug flag, like cobra's init order", async () => {
    // AutomaticEnv binds inside cobra.OnInitialize, which --help/--version
    // never reach; BindPFlags runs at package init, so the flag still reads.
    const viaEnv = setup({
      fetchFails: true,
      project: false,
      env: { SUPABASE_DEBUG: "1" },
      args: ["--version"],
    });
    await legacyRunUpgradeNotice(viaEnv.deps);
    expect(viaEnv.stderr).toBe("");
    viaEnv.cleanup();

    const viaFlag = setup({ fetchFails: true, project: false, args: ["--version", "--debug"] });
    await legacyRunUpgradeNotice(viaFlag.deps);
    expect(viaFlag.stderr).toContain("Failed to fetch latest release: offline");
    viaFlag.cleanup();
  });

  it("a failed fetch stays silent and writes an empty cache to back off", async () => {
    const ctx = setup({ fetchFails: true });
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.stderr).toBe("");
    expect(readFileSync(ctx.cachePath, "utf8")).toBe("");
    ctx.cleanup();
  });

  it("a failed fetch surfaces its error under --debug when there is no project to back off in", async () => {
    const ctx = setup({ fetchFails: true, project: false, args: ["db", "start", "--debug"] });
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.stderr).toContain("Failed to fetch latest release");
    expect(ctx.stderr).not.toContain("A new version of Supabase CLI is available");
    ctx.cleanup();
  });

  it("a --debug operand after -- or consumed by a value flag is not the debug flag, like pflag", async () => {
    const afterTerminator = setup({
      fetchFails: true,
      project: false,
      args: ["db", "start", "--", "--debug"],
    });
    await legacyRunUpgradeNotice(afterTerminator.deps);
    expect(afterTerminator.stderr).toBe("");
    afterTerminator.cleanup();

    const consumedValue = setup({
      fetchFails: true,
      project: false,
      args: ["--profile", "--debug", "db", "start"],
    });
    await legacyRunUpgradeNotice(consumedValue.deps);
    expect(consumedValue.stderr).toBe("");
    consumedValue.cleanup();
  });

  it.skipIf(process.getuid?.() === 0)(
    "a cache write failure reports the stable cli-latest path, never the temp file",
    async () => {
      const ctx = setup({ args: ["db", "start", "--debug"] });
      mkdirSync(join(workdir, "supabase", ".temp"), { recursive: true });
      chmodSync(join(workdir, "supabase", ".temp"), 0o555);
      await legacyRunUpgradeNotice(ctx.deps);
      chmodSync(join(workdir, "supabase", ".temp"), 0o755);
      expect(ctx.stderr).toContain("failed to write file");
      expect(ctx.stderr).toContain("cli-latest");
      expect(ctx.stderr).not.toContain("cli-latest.tmp");
      ctx.cleanup();
    },
  );

  it("a failed fetch inside a project stays silent under --debug, matching Go's backoff", async () => {
    const ctx = setup({ fetchFails: true, args: ["db", "start", "--debug"] });
    await legacyRunUpgradeNotice(ctx.deps);
    // The empty-cache backoff write succeeds, so Go emits no debug line.
    expect(ctx.stderr).toBe("");
    expect(readFileSync(ctx.cachePath, "utf8")).toBe("");
    ctx.cleanup();
  });

  it("outside a project the notice still prints but nothing is cached", async () => {
    const ctx = setup({ project: false });
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.stderr).toContain("v2.114.0");
    expect(() => readFileSync(ctx.cachePath, "utf8")).toThrow();
    ctx.cleanup();
  });

  it("resolves the cache under --workdir, then SUPABASE_WORKDIR, ahead of the cwd walk", async () => {
    const ctx = setup({ project: false });
    const flagDir = join(workdir, "flag-project");
    const envDir = join(workdir, "env-project");
    for (const dir of [flagDir, envDir]) {
      mkdirSync(join(dir, "supabase"), { recursive: true });
    }
    const flagCtx = { ...ctx.deps, args: ["db", "start", "--workdir", flagDir] };
    await legacyRunUpgradeNotice(flagCtx);
    expect(readFileSync(join(flagDir, "supabase", ".temp", "cli-latest"), "utf8")).toBe("v2.114.0");

    const lastWinsCtx = {
      ...ctx.deps,
      args: ["db", "start", "--workdir", join(workdir, "ignored"), `--workdir=${flagDir}`],
    };
    await legacyRunUpgradeNotice(lastWinsCtx);
    expect(readFileSync(join(flagDir, "supabase", ".temp", "cli-latest"), "utf8")).toBe("v2.114.0");

    const envCtx = { ...ctx.deps, env: { SUPABASE_WORKDIR: envDir } };
    await legacyRunUpgradeNotice(envCtx);
    expect(readFileSync(join(envDir, "supabase", ".temp", "cli-latest"), "utf8")).toBe("v2.114.0");
    ctx.cleanup();
  });

  it("an explicit empty --workdir beats SUPABASE_WORKDIR and falls back to the walk, like viper", async () => {
    const ctx = setup({});
    const envDir = join(workdir, "env-project");
    mkdirSync(join(envDir, "supabase"), { recursive: true });
    await legacyRunUpgradeNotice({
      ...ctx.deps,
      args: ["db", "start", "--workdir="],
      env: { SUPABASE_WORKDIR: envDir },
    });
    // The set-but-empty flag suppresses the env, so the walk finds the real project.
    expect(readFileSync(ctx.cachePath, "utf8")).toBe("v2.114.0");
    expect(() => readFileSync(join(envDir, "supabase", ".temp", "cli-latest"), "utf8")).toThrow();
    ctx.cleanup();
  });

  it("a project dotenv SUPABASE_NO_UPDATE_NOTIFIER opt-out suppresses the notice, like godotenv", async () => {
    const ctx = setup({});
    writeFileSync(join(workdir, "supabase", ".env"), "SUPABASE_NO_UPDATE_NOTIFIER=1\n");
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.fetchCalls).toBe(0);
    expect(ctx.stderr).toBe("");
    ctx.cleanup();
  });

  it("a shell env that defines the key beats the project dotenv, like godotenv's no-override", async () => {
    // Defined-but-unparseable in the shell env: Go's os.Environ presence stops
    // godotenv from overriding, and ParseBool("") keeps the notifier on.
    const ctx = setup({ env: { SUPABASE_NO_UPDATE_NOTIFIER: "" } });
    writeFileSync(join(workdir, "supabase", ".env"), "SUPABASE_NO_UPDATE_NOTIFIER=1\n");
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.stderr).toContain("A new version of Supabase CLI is available");
    ctx.cleanup();
  });

  it("--help ignores the project dotenv opt-out — Go never loads config for the built-ins", async () => {
    const ctx = setup({ args: ["--help"] });
    writeFileSync(join(workdir, "supabase", ".env"), "SUPABASE_NO_UPDATE_NOTIFIER=1\n");
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.stderr).toContain("A new version of Supabase CLI is available");
    ctx.cleanup();
  });

  it("resolves --help and --version against the bare cwd, ignoring --workdir, like Go", async () => {
    // Go serves the built-ins without `ChangeWorkDir`, so the flagged project
    // must not gain a cache entry; the caller's cwd (no supabase/) writes none.
    const ctx = setup({ project: false });
    const flagged = join(workdir, "flagged");
    mkdirSync(join(flagged, "supabase"), { recursive: true });
    for (const args of [
      ["--workdir", flagged, "--help"],
      ["--workdir", flagged, "--version"],
      // pflag's valued and clustered spellings request the same built-ins —
      // and a false value still does: the non-runnable root/group serves help
      // before cobra ever reaches `preRun`.
      ["--workdir", flagged, "--help=true"],
      ["branches", "--workdir", flagged, "-h=1"],
      ["--workdir", flagged, "--version=true"],
      ["--workdir", flagged, "-hv"],
      ["branches", "--workdir", flagged, "--help=true", "--help=false"],
      // The space-form operand never stops the root version built-in.
      ["--workdir", flagged, "--version", "true"],
    ]) {
      await legacyRunUpgradeNotice({ ...ctx.deps, args });
    }
    expect(() => readFileSync(join(flagged, "supabase", ".temp", "cli-latest"), "utf8")).toThrow();
    // A subcommand's own value-taking --version still resolves the project.
    await legacyRunUpgradeNotice({
      ...ctx.deps,
      args: ["db", "reset", "--workdir", flagged, "--version", "20240101000000"],
    });
    expect(readFileSync(join(flagged, "supabase", ".temp", "cli-latest"), "utf8")).toBe("v2.114.0");
    ctx.cleanup();
  });

  it("a clean group-help exit resolves against the bare cwd, ignoring --workdir", async () => {
    const ctx = setup({ project: false });
    const flagged = join(workdir, "flagged");
    mkdirSync(join(flagged, "supabase"), { recursive: true });
    await legacyRunUpgradeNotice({
      ...ctx.deps,
      args: ["branches", "--workdir", flagged],
      cleanShowHelp: true,
    });
    // Go serves the bare group's help without ChangeWorkDir: nothing lands in
    // the flagged project, and the caller's cwd (no supabase/) writes nothing.
    expect(() => readFileSync(join(flagged, "supabase", ".temp", "cli-latest"), "utf8")).toThrow();
    expect(ctx.stderr).toContain("v2.114.0");
    ctx.cleanup();
  });

  it("ignores a --workdir operand after the -- terminator, like cobra", async () => {
    const ctx = setup({});
    const elsewhere = join(workdir, "elsewhere");
    mkdirSync(join(elsewhere, "supabase"), { recursive: true });
    const opCtx = { ...ctx.deps, args: ["db", "start", "--", "--workdir", elsewhere] };
    await legacyRunUpgradeNotice(opCtx);
    // The operand is not a flag: the cache lands in the real project, not `elsewhere`.
    expect(readFileSync(ctx.cachePath, "utf8")).toBe("v2.114.0");
    expect(() =>
      readFileSync(join(elsewhere, "supabase", ".temp", "cli-latest"), "utf8"),
    ).toThrow();
    ctx.cleanup();
  });

  it("never reads through or writes through a symlinked cache file", async () => {
    const ctx = setup({});
    const victim = join(workdir, "victim.txt");
    writeFileSync(victim, "v9.9.9");
    mkdirSync(join(workdir, "supabase", ".temp"), { recursive: true });
    symlinkSync(victim, ctx.cachePath);
    await legacyRunUpgradeNotice(ctx.deps);
    expect(ctx.fetchCalls).toBe(1);
    expect(ctx.stderr).toContain("v2.114.0");
    expect(ctx.stderr).not.toContain("v9.9.9");
    expect(readFileSync(victim, "utf8")).toBe("v9.9.9");
    expect(lstatSync(ctx.cachePath).isSymbolicLink()).toBe(true);
    ctx.cleanup();
  });

  it.each(["supabase", "supabase/.temp"])(
    "never writes through a symlinked %s directory",
    async (linked) => {
      const ctx = setup({ project: false });
      const outside = join(workdir, "outside");
      mkdirSync(outside, { recursive: true });
      if (linked !== "supabase") mkdirSync(join(workdir, "supabase"), { recursive: true });
      symlinkSync(outside, join(workdir, linked));

      await legacyRunUpgradeNotice(ctx.deps);

      expect(ctx.stderr).toContain("v2.114.0");
      expect(readdirSync(outside)).toEqual([]);
      ctx.cleanup();
    },
  );

  it("prints only the trimmed, validated tag and rejects embedded escape bytes", async () => {
    const trailing = setup({ cacheContent: "v2.115.0\r\n", cacheAgeMs: 60_000 });
    await legacyRunUpgradeNotice(trailing.deps);
    expect(trailing.stderr).toContain("available: v2.115.0 (currently installed");
    trailing.cleanup();

    const embedded = setup({ cacheContent: "v2.115.0\u001b[31mboo", cacheAgeMs: 60_000 });
    await legacyRunUpgradeNotice(embedded.deps);
    expect(embedded.stderr).toBe("");
    embedded.cleanup();
  });
});
