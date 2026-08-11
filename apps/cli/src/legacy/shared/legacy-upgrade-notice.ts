/**
 * Port of Go's post-command upgrade notice (`cmd/root.go`'s `checkUpgrade`/
 * `shouldFetchRelease`/`suggestUpgrade`), with the `SUPABASE_NO_UPDATE_NOTIFIER`
 * opt-out from supabase/cli#5853. An empty cache written on a failed fetch is
 * Go's own offline backoff.
 */

import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { Effect } from "effect";

import {
  hasRootHelpOrVersionFlag,
  hasRootVersionFlag,
  lastGlobalFlagValue,
  rootFlagTokens,
} from "../../shared/cli/run.ts";
import { CLI_VERSION } from "../../shared/cli/version.ts";
import { legacyBold, legacyYellow } from "./legacy-colors.ts";
import { parseDotEnv } from "./legacy-dotenv.ts";
import { legacyCandidateDotenvFilenames } from "./legacy-project-environment.ts";

const LATEST_RELEASE_URL = "https://api.github.com/repos/supabase/cli/releases/latest";
const UPGRADE_GUIDE_URL =
  "https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli";
const CACHE_TTL_MS = 10 * 60 * 60 * 1000;
/** No Go equivalent (its client sets no timeout); bounds this pre-exit hook's latency. */
const FETCH_TIMEOUT_MS = 3000;

/** Go `strconv.ParseBool`'s true spellings — anything else, including garbage, leaves the notifier on. */
const PARSE_BOOL_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);

export function legacyUpdateNotifierDisabled(value: string | undefined): boolean {
  return value !== undefined && PARSE_BOOL_TRUE.has(value);
}

/**
 * Go's `viper.GetBool("DEBUG")`: the `--debug`/`--debug=<bool>` flag when set
 * (last wins; `viper.BindPFlags` runs at package init, so the flag reads even
 * for the built-ins), else `SUPABASE_DEBUG` — but the env only when a real
 * command ran: `viper.AutomaticEnv` binds inside `cobra.OnInitialize`, which
 * `--help`/`--version`/a bare group's help never reach (Go says so itself at
 * `updateNotifierEnabled`, `cmd/root.go:246-247`). The token walk skips
 * operands after `--` and values consumed by value-taking global flags, which
 * pflag never reads as flags.
 */
function debugEnabled(deps: LegacyUpgradeNoticeDeps, builtin: boolean): boolean {
  let flag: boolean | undefined;
  for (const { token } of rootFlagTokens(deps.args)) {
    if (token === "--debug") flag = true;
    else if (token.startsWith("--debug=")) {
      flag = PARSE_BOOL_TRUE.has(token.slice("--debug=".length));
    }
  }
  if (flag !== undefined) return flag;
  if (builtin) return false;
  const env = deps.env["SUPABASE_DEBUG"];
  return env !== undefined && PARSE_BOOL_TRUE.has(env);
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface ParsedSemver {
  readonly nums: readonly [number, number, number];
  readonly prerelease: string;
}

/**
 * `x/mod/semver` requires the leading `v` — a bare `2.114.0` is invalid to Go
 * and must stay invalid here. Go additionally rejects leading zeros in numeric
 * prerelease identifiers and accepts shortened `v2`/`v2.1` forms; both are
 * unreachable for real release tags, so neither is reproduced.
 */
function parseSemver(version: string): ParsedSemver | undefined {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (match === null) return undefined;
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? "",
  };
}

/**
 * Go's `semver.Compare(latest, "v"+utils.Version) > 0` gate: an invalid latest
 * tag (including the empty offline-cache sentinel) never suggests, an invalid
 * current version (Go dev builds carry an empty `utils.Version`) always does.
 */
export function legacyIsNewerCliVersion(latestTag: string, currentVersion: string): boolean {
  const latest = parseSemver(latestTag);
  if (latest === undefined) return false;
  const current = parseSemver(`v${currentVersion}`);
  if (current === undefined) return true;
  for (let index = 0; index < 3; index++) {
    const left = latest.nums[index] ?? 0;
    const right = current.nums[index] ?? 0;
    if (left !== right) return left > right;
  }
  if (latest.prerelease === current.prerelease) return false;
  if (latest.prerelease === "") return true;
  if (current.prerelease === "") return false;
  return comparePrerelease(latest.prerelease, current.prerelease) > 0;
}

/** Semver-spec prerelease precedence, matching Go's `comparePrerelease` (numeric identifiers compare numerically, so `beta.9 < beta.10`). */
function comparePrerelease(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
    const a = leftParts[index] ?? "";
    const b = rightParts[index] ?? "";
    if (a === b) continue;
    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);
    if (aNum && bNum) return Number(a) - Number(b);
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return leftParts.length - rightParts.length;
}

/**
 * Byte-for-byte Go `suggestUpgrade`. Styling goes through `legacy-colors.ts`:
 * raw `styleText` paints escapes unconditionally on Bun, even under `NO_COLOR`
 * and on piped stderr.
 */
export function legacyFormatUpgradeNotice(latestTag: string, currentVersion: string): string {
  return (
    `A new version of Supabase CLI is available: ${legacyYellow(latestTag)} (currently installed v${currentVersion})\n` +
    `We recommend updating regularly for new features and bug fixes: ${legacyBold(UPGRADE_GUIDE_URL)}`
  );
}

/**
 * The directory Go's relative `supabase/.temp` paths resolve against after
 * `ChangeWorkDir`, matching `legacy-cli-config.layer.ts`'s `resolveWorkdir`
 * precedence. Not reused from there: that resolution lives inside a command's
 * own layer stack, and this hook also runs for `--help`/`--version`, which
 * never build one.
 */
function resolveNoticeBaseDir(
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): string {
  // Viper: a set flag beats the env even when empty, and an empty effective
  // value falls through to the ancestor walk (`ChangeWorkDir`'s own rule).
  const flagValue = lastGlobalFlagValue(args, "--workdir");
  const explicit = flagValue !== undefined ? flagValue : env["SUPABASE_WORKDIR"];
  if (explicit !== undefined && explicit !== "") {
    return resolve(cwd, explicit);
  }
  let current = cwd;
  while (true) {
    if (existsSync(join(current, "supabase", "config.toml"))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

/**
 * The project dotenv chain's `SUPABASE_NO_UPDATE_NOTIFIER`, or `undefined`.
 * Go's `godotenv.Load` writes the chain into the real environment before
 * `updateNotifierEnabled` reads it (`pkg/config/config.go:1220-1241`), so a
 * project-level opt-out suppresses the notice whenever the command loaded its
 * config. This hook cannot see whether the run's command did, so it honors the
 * opt-out for every real command — the only divergence from Go is a
 * suppressed notice for a user who opted out anyway. Same chain and
 * precedence as `legacyResolveProjectEnvironmentValues`: `<base>/supabase`
 * then `<base>`, first file to define the key wins, and a shell env that
 * defines the key at all (godotenv never overrides) skips the walk entirely.
 */
async function projectDotenvNotifierOptOut(
  base: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  if (env["SUPABASE_NO_UPDATE_NOTIFIER"] !== undefined) return undefined;
  // Go's walk loads `<base>/supabase` then `<base>` — except at the filesystem
  // root, where `loadNestedEnv`'s `cwd != filepath.Dir(repoDir)` bound
  // degenerates (`Dir("/") == "/"`) and only `/supabase` is read.
  const dirs = dirname(base) === base ? [join(base, "supabase")] : [join(base, "supabase"), base];
  for (const dir of dirs) {
    for (const filename of legacyCandidateDotenvFilenames(env["SUPABASE_ENV"] || "development")) {
      const contents = await readFile(join(dir, filename), "utf8").catch(() => undefined);
      if (contents === undefined) continue;
      try {
        const value = parseDotEnv(contents)["SUPABASE_NO_UPDATE_NOTIFIER"];
        if (value !== undefined) return value;
      } catch {
        // A malformed file is only reachable here when the command never
        // loaded config (a load would have failed the run before this hook),
        // and then Go never reads the file either.
        return undefined;
      }
    }
  }
  return undefined;
}

/** Absent (we may create it) or a real directory — never a symlink to follow. */
async function isRealDirOrAbsent(path: string): Promise<boolean> {
  const stats = await lstat(path).catch(() => undefined);
  return stats === undefined || stats.isDirectory();
}

export interface LegacyUpgradeNoticeDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly args: ReadonlyArray<string>;
  /** The exit-0 ShowHelp branch (bare group command) — served without Go's `ChangeWorkDir`. */
  readonly cleanShowHelp?: boolean;
  readonly cwd: string;
  readonly currentVersion: string;
  readonly now: () => number;
  readonly fetchLatestTag: () => Promise<string>;
  readonly writeStderr: (text: string) => void;
}

export async function legacyRunUpgradeNotice(deps: LegacyUpgradeNoticeDeps): Promise<void> {
  if (legacyUpdateNotifierDisabled(deps.env["SUPABASE_NO_UPDATE_NOTIFIER"])) return;

  // `--help`/`--version` and a bare group's clean ShowHelp all skip cobra's
  // `PersistentPreRunE`, so Go never runs `ChangeWorkDir` for them — the cache
  // resolves against the bare cwd, with `--workdir`/`SUPABASE_WORKDIR` and the
  // ancestor walk all ignored — and never reaches a config load that could
  // pull the opt-out from a project dotenv.
  const builtin = deps.cleanShowHelp === true || hasRootHelpOrVersionFlag(deps.args);
  const base = builtin ? deps.cwd : resolveNoticeBaseDir(deps.cwd, deps.args, deps.env);
  if (!builtin && legacyUpdateNotifierDisabled(await projectDotenvNotifierOptOut(base, deps.env))) {
    return;
  }
  const supabaseDir = join(base, "supabase");
  const tempDir = join(supabaseDir, ".temp");
  const cacheFile = join(tempDir, "cli-latest");

  // A hostile checkout can commit a symlink at any level of this well-known
  // path to clobber an arbitrary user-writable file (CWE-59): a symlink
  // anywhere disables the cache. Do not relax to `stat`/`existsSync`, which
  // follow links. A check-then-write window remains: Node has no `openat`.
  const cacheLstat = await lstat(cacheFile).catch(() => undefined);
  const cachePathIsSafe =
    cacheLstat?.isSymbolicLink() !== true &&
    (await isRealDirOrAbsent(supabaseDir)) &&
    (await isRealDirOrAbsent(tempDir));

  // Go's `rootCmd.Flag("version").Changed` — a subcommand's own `--version` must not bypass the cache.
  const forceFetch = hasRootVersionFlag(deps.args);
  const cacheFresh =
    cachePathIsSafe &&
    cacheLstat !== undefined &&
    deps.now() < cacheLstat.mtime.getTime() + CACHE_TTL_MS;

  let latestTag: string;
  if (forceFetch || !cacheFresh) {
    let notifyError: Error | undefined;
    latestTag = (
      await deps.fetchLatestTag().catch((error: unknown) => {
        // Go's `GetLatestRelease` wrap (`internal/utils/release.go:42`) —
        // capital F and all.
        notifyError = new Error(`Failed to fetch latest release: ${errorMessage(error)}`);
        return "";
      })
    ).trim();
    // Go's `checkUpgrade` (`cmd/root.go:254-258`) overwrites the fetch error
    // with the offline-backoff write's result when inside a project, so a
    // successful write silences the diagnostic — only a missing project (no
    // backoff) or a failing write leaves an error to log, carrying the write
    // path's own wraps (`failed to mkdir`/`failed to write file`, misc.go).
    if (cachePathIsSafe && existsSync(supabaseDir)) {
      const tempFile = join(tempDir, `cli-latest.tmp.${crypto.randomUUID()}`);
      notifyError = await mkdir(tempDir, { recursive: true }).then(
        () =>
          writeFile(tempFile, latestTag)
            .then(() => rename(tempFile, cacheFile))
            .then(() => undefined)
            .catch((error: unknown) =>
              rm(tempFile, { force: true })
                .catch(() => undefined)
                .then(() => new Error(`failed to write file: ${errorMessage(error)}`)),
            ),
        (error: unknown) => new Error(`failed to mkdir: ${errorMessage(error)}`),
      );
    }
    if (notifyError !== undefined && debugEnabled(deps, builtin)) {
      deps.writeStderr(`${stripVTControlCharacters(notifyError.message)}\n`);
    }
  } else {
    latestTag = (
      await readFile(cacheFile, "utf8").catch((error: unknown) => {
        if (debugEnabled(deps, builtin)) {
          deps.writeStderr(
            `failed to read cli version: ${stripVTControlCharacters(errorMessage(error))}\n`,
          );
        }
        return "";
      })
    ).trim();
  }

  // Gated on the anchored semver match: no escape bytes can reach the terminal.
  if (legacyIsNewerCliVersion(latestTag, deps.currentVersion)) {
    deps.writeStderr(`${legacyFormatUpgradeNotice(latestTag, deps.currentVersion)}\n`);
  }
}

async function fetchLatestReleaseTag(): Promise<string> {
  // Go's `GetGitHubClient` authenticates when GITHUB_TOKEN is set, for the
  // higher rate limit on shared-egress CI runners.
  const token = process.env["GITHUB_TOKEN"];
  const response = await fetch(LATEST_RELEASE_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `SupabaseCLI/${CLI_VERSION}`,
      ...(token !== undefined && token !== "" ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`unexpected status ${response.status}`);
  }
  const body: unknown = await response.json();
  const tag =
    typeof body === "object" && body !== null && "tag_name" in body ? body.tag_name : undefined;
  return typeof tag === "string" ? tag : "";
}

/** The `runCli` post-success hook. A rejected `Effect.promise` is a defect, so `Effect.ignoreCause` (not `ignore`) keeps this unable to fail. */
export const legacyUpgradeNoticeHook = (
  args: ReadonlyArray<string>,
  info: { readonly cleanShowHelp: boolean },
): Effect.Effect<void> =>
  Effect.promise(() =>
    legacyRunUpgradeNotice({
      env: process.env,
      args,
      cleanShowHelp: info.cleanShowHelp,
      cwd: process.cwd(),
      currentVersion: CLI_VERSION,
      now: Date.now,
      fetchLatestTag: fetchLatestReleaseTag,
      writeStderr: (text) => {
        process.stderr.write(text);
      },
    }),
  ).pipe(Effect.ignoreCause);
