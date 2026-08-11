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

import { hasRootVersionFlag } from "../../shared/cli/run.ts";
import { CLI_VERSION } from "../../shared/cli/version.ts";
import { legacyBold, legacyYellow } from "./legacy-colors.ts";

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

/** Go's `viper.GetBool("DEBUG")`: the `--debug`/`--debug=<bool>` flag when set (last wins), else `SUPABASE_DEBUG`. */
function debugEnabled(deps: LegacyUpgradeNoticeDeps): boolean {
  let flag: boolean | undefined;
  for (const arg of deps.args) {
    if (arg === "--debug") flag = true;
    else if (arg.startsWith("--debug=")) flag = PARSE_BOOL_TRUE.has(arg.slice("--debug=".length));
  }
  if (flag !== undefined) return flag;
  const env = deps.env["SUPABASE_DEBUG"];
  return env !== undefined && PARSE_BOOL_TRUE.has(env);
}

interface ParsedSemver {
  readonly nums: readonly [number, number, number];
  readonly prerelease: string;
}

/** Go additionally rejects leading zeros in numeric prerelease identifiers; unreachable for real release tags, so not reproduced. */
function parseSemver(version: string): ParsedSemver | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
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
  const current = parseSemver(currentVersion);
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
  let flagValue: string | undefined;
  for (const [index, arg] of args.entries()) {
    if (arg === "--workdir") flagValue = args[index + 1];
    else if (arg.startsWith("--workdir=")) flagValue = arg.slice("--workdir=".length);
  }
  const explicit =
    flagValue !== undefined && flagValue !== "" ? flagValue : env["SUPABASE_WORKDIR"];
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

/** Absent (we may create it) or a real directory — never a symlink to follow. */
async function isRealDirOrAbsent(path: string): Promise<boolean> {
  const stats = await lstat(path).catch(() => undefined);
  return stats === undefined || stats.isDirectory();
}

export interface LegacyUpgradeNoticeDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly currentVersion: string;
  readonly now: () => number;
  readonly fetchLatestTag: () => Promise<string>;
  readonly writeStderr: (text: string) => void;
}

export async function legacyRunUpgradeNotice(deps: LegacyUpgradeNoticeDeps): Promise<void> {
  if (legacyUpdateNotifierDisabled(deps.env["SUPABASE_NO_UPDATE_NOTIFIER"])) return;

  const base = resolveNoticeBaseDir(deps.cwd, deps.args, deps.env);
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
    latestTag = (
      await deps.fetchLatestTag().catch((error: unknown) => {
        if (debugEnabled(deps)) {
          deps.writeStderr(
            `failed to fetch latest release: ${stripVTControlCharacters(String(error))}\n`,
          );
        }
        return "";
      })
    ).trim();
    if (cachePathIsSafe && existsSync(supabaseDir)) {
      const tempFile = join(tempDir, `cli-latest.tmp.${crypto.randomUUID()}`);
      await mkdir(tempDir, { recursive: true })
        .then(() => writeFile(tempFile, latestTag))
        .then(() => rename(tempFile, cacheFile))
        .catch(() => rm(tempFile, { force: true }).catch(() => undefined));
    }
  } else {
    latestTag = (
      await readFile(cacheFile, "utf8").catch((error: unknown) => {
        if (debugEnabled(deps)) {
          deps.writeStderr(
            `failed to read cli version: ${stripVTControlCharacters(String(error))}\n`,
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
export const legacyUpgradeNoticeHook = (args: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.promise(() =>
    legacyRunUpgradeNotice({
      env: process.env,
      args,
      cwd: process.cwd(),
      currentVersion: CLI_VERSION,
      now: Date.now,
      fetchLatestTag: fetchLatestReleaseTag,
      writeStderr: (text) => {
        process.stderr.write(text);
      },
    }),
  ).pipe(Effect.ignoreCause);
