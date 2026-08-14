/**
 * Port of Go's post-command upgrade notice (`cmd/root.go`'s `checkUpgrade`/
 * `shouldFetchRelease`/`suggestUpgrade`), with the `SUPABASE_NO_UPDATE_NOTIFIER`
 * opt-out from supabase/cli#5853. An empty cache written on a failed fetch is
 * Go's own offline backoff.
 */

import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
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
function debugEnabled(
  deps: LegacyUpgradeNoticeDeps,
  builtin: boolean,
  effectiveDebugEnv: string | undefined,
): boolean {
  let flag: boolean | undefined;
  for (const { token } of rootFlagTokens(deps.args, deps.isValueTakingFlagToken)) {
    if (token === "--debug") flag = true;
    else if (token.startsWith("--debug=")) {
      flag = PARSE_BOOL_TRUE.has(token.slice("--debug=".length));
    }
  }
  if (flag !== undefined) return flag;
  if (builtin) return false;
  return effectiveDebugEnv !== undefined && PARSE_BOOL_TRUE.has(effectiveDebugEnv);
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface ParsedSemver {
  readonly nums: readonly [string, string, string];
  readonly prerelease: string;
}

function parseSemver(version: string): ParsedSemver | undefined {
  const match =
    /^v(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)?(?![\s\S])/.exec(
      version,
    );
  if (match === null) return undefined;
  const prerelease = match[4] ?? "";
  if (
    prerelease
      .split(".")
      .some(
        (identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === "0",
      )
  ) {
    return undefined;
  }
  return {
    nums: [match[1]!, match[2] ?? "0", match[3] ?? "0"],
    prerelease,
  };
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
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
    const comparison = compareNumericIdentifier(latest.nums[index]!, current.nums[index]!);
    if (comparison !== 0) return comparison > 0;
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
    if (aNum && bNum) return compareNumericIdentifier(a, b);
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
 * Writes the cache file refusing to follow a symlink at the FINAL path
 * component. The `lstat` guard at the call site runs before a network fetch
 * bounded only by `FETCH_TIMEOUT_MS`, so by write time it only proves the path
 * was safe seconds ago; a concurrent process that swaps `cli-latest` for a
 * symlink inside that window makes a plain `writeFile` truncate an arbitrary
 * user-writable target (CWE-59/TOCTOU). `O_NOFOLLOW` moves that one decision
 * into the kernel's `open`, which fails with `ELOOP` instead.
 *
 * This does NOT close the window for the `supabase/` and `.temp/` DIRECTORY
 * components: `O_NOFOLLOW` only applies to the last component, and resolving
 * the rest against a verified directory handle needs `openat`, which Node does
 * not expose. A directory swapped for a symlink inside the same window is still
 * followed by the preceding `mkdir -p` and by this `open`. Those components
 * keep only the advisory `lstat`/`isRealDirOrAbsent` checks — narrower than the
 * final-component guarantee, and still stricter than Go, which writes through
 * symlinks at every level.
 *
 * Same path, mode, and truncate semantics as the `writeFile` it replaces, so
 * Go's filesystem side effects are unchanged — including the empty-string
 * offline backoff write.
 *
 * `O_NOFOLLOW` is POSIX-only; Node leaves it undefined on Windows, where this
 * falls back to the plain flags and the final component drops back to the same
 * advisory-only footing as the directories. Creating a symlink there needs
 * Developer Mode or `SeCreateSymbolicLinkPrivilege`.
 */
async function writeCacheFileNoFollow(cacheFile: string, contents: string): Promise<void> {
  const handle = await open(
    cacheFile,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o644,
  );
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
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
  isValueTakingFlagToken?: (token: string) => boolean,
): string {
  // Viper: a set flag beats the env even when empty, and an empty effective
  // value falls through to the ancestor walk (`ChangeWorkDir`'s own rule).
  const flagValue = lastGlobalFlagValue(args, "--workdir", isValueTakingFlagToken);
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
 * The project dotenv chain as a merged map, mirroring what Go's
 * `godotenv.Load` writes into the real environment before the `Execute()`
 * tail reads `SUPABASE_NO_UPDATE_NOTIFIER` and `viper` reads `SUPABASE_DEBUG`
 * (`pkg/config/config.go:1220-1241`) — but only when the command loaded its
 * config. This hook cannot see whether the run's command did, so it reads the
 * chain for every real command; the only divergences from Go are a suppressed
 * notice, or an extra debug diagnostic, for a project that configured exactly
 * that. Same chain and precedence as `legacyResolveProjectEnvironmentValues`:
 * `<base>/supabase` then `<base>`, first file to define a key wins, and the
 * shell env always beats a chain value (godotenv never overrides).
 */
async function projectDotenvValues(
  base: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  // Go's walk loads `<base>/supabase` then `<base>` — except at the filesystem
  // root, where `loadNestedEnv`'s `cwd != filepath.Dir(repoDir)` bound
  // degenerates (`Dir("/") == "/"`) and only `/supabase` is read.
  const dirs = dirname(base) === base ? [join(base, "supabase")] : [join(base, "supabase"), base];
  for (const dir of dirs) {
    for (const filename of legacyCandidateDotenvFilenames(env["SUPABASE_ENV"] || "development")) {
      const contents = await readFile(join(dir, filename), "utf8").catch(() => undefined);
      if (contents === undefined) continue;
      try {
        for (const [key, value] of Object.entries(parseDotEnv(contents))) {
          if (!(key in merged)) merged[key] = value;
        }
      } catch {
        // A malformed file is only reachable here when the command never
        // loaded config (a load would have failed the run before this hook),
        // and then Go never read any of the chain either.
        return {};
      }
    }
  }
  return merged;
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
  /** Value-taking-token predicate for this argv (global + resolved leaf flags), so a token a local flag consumed (`login --name --debug`) is never read as a flag. */
  readonly isValueTakingFlagToken?: (token: string) => boolean;
  readonly cwd: string;
  readonly resolvedCwd?: string;
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
  const builtin =
    deps.cleanShowHelp === true || hasRootHelpOrVersionFlag(deps.args, deps.isValueTakingFlagToken);
  const base = builtin
    ? deps.cwd
    : (deps.resolvedCwd ??
      resolveNoticeBaseDir(deps.cwd, deps.args, deps.env, deps.isValueTakingFlagToken));
  const projectEnv = builtin ? {} : await projectDotenvValues(base, deps.env);
  // godotenv never overrides: a shell env that defines a key at all beats the
  // project dotenv chain, even when set to an empty or unparseable value.
  const effectiveEnv = (key: string): string | undefined =>
    deps.env[key] !== undefined ? deps.env[key] : projectEnv[key];
  if (legacyUpdateNotifierDisabled(effectiveEnv("SUPABASE_NO_UPDATE_NOTIFIER"))) return;
  const debug = debugEnabled(deps, builtin, effectiveEnv("SUPABASE_DEBUG"));
  const supabaseDir = join(base, "supabase");
  const tempDir = join(supabaseDir, ".temp");
  const cacheFile = join(tempDir, "cli-latest");

  // A hostile checkout can commit a symlink at any level of this well-known
  // path to clobber an arbitrary user-writable file (CWE-59): a symlink
  // anywhere disables the cache. Do not relax to `stat`/`existsSync`, which
  // follow links. These checks are advisory only — they run before a fetch that
  // can take FETCH_TIMEOUT_MS, so they cannot be trusted at write time. The
  // write re-establishes the guarantee in the kernel for the cache file itself
  // via `O_NOFOLLOW`; the two directory components stay advisory-only for want
  // of `openat` (see `writeCacheFileNoFollow`).
  const cacheLstat = await lstat(cacheFile).catch(() => undefined);
  const cachePathIsSafe =
    cacheLstat?.isSymbolicLink() !== true &&
    (await isRealDirOrAbsent(supabaseDir)) &&
    (await isRealDirOrAbsent(tempDir));

  // Go's `rootCmd.Flag("version").Changed` — a subcommand's own `--version` must not bypass the cache.
  const forceFetch = hasRootVersionFlag(deps.args, deps.isValueTakingFlagToken);
  const cacheFresh =
    cachePathIsSafe &&
    cacheLstat !== undefined &&
    deps.now() <= cacheLstat.mtime.getTime() + CACHE_TTL_MS;

  let latestTag: string;
  if (forceFetch || !cacheFresh) {
    let notifyError: Error | undefined;
    latestTag = await deps.fetchLatestTag().catch((error: unknown) => {
      // Go's `GetLatestRelease` wrap (`internal/utils/release.go:42`) —
      // capital F and all.
      notifyError = new Error(`Failed to fetch latest release: ${errorMessage(error)}`);
      return "";
    });
    // Go's `checkUpgrade` (`cmd/root.go:254-258`) overwrites the fetch error
    // with the offline-backoff write's result when inside a project, so a
    // successful write silences the diagnostic — only a missing project (no
    // backoff) or a failing write leaves an error to log, carrying the write
    // path's own wraps (`failed to mkdir`/`failed to write file`, misc.go).
    if (cachePathIsSafe && existsSync(supabaseDir)) {
      notifyError = await mkdir(tempDir, { recursive: true, mode: 0o755 }).then(
        () =>
          writeCacheFileNoFollow(cacheFile, latestTag).then(
            () => undefined,
            (error: unknown) => new Error(`failed to write file: ${errorMessage(error)}`),
          ),
        (error: unknown) => new Error(`failed to mkdir: ${errorMessage(error)}`),
      );
    }
    if (notifyError !== undefined && debug) {
      deps.writeStderr(`${stripVTControlCharacters(notifyError.message)}\n`);
    }
  } else {
    latestTag = await readFile(cacheFile, "utf8").catch((error: unknown) => {
      if (debug) {
        deps.writeStderr(
          `failed to read cli version: ${stripVTControlCharacters(errorMessage(error))}\n`,
        );
      }
      return "";
    });
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
  info: {
    readonly cleanShowHelp: boolean;
    readonly delegatedToGo: boolean;
    readonly workingDirectory?: string;
    readonly isValueTakingFlagToken: (token: string) => boolean;
  },
): Effect.Effect<void> =>
  info.delegatedToGo
    ? Effect.void
    : Effect.promise(() =>
        legacyRunUpgradeNotice({
          env: process.env,
          args,
          cleanShowHelp: info.cleanShowHelp,
          isValueTakingFlagToken: info.isValueTakingFlagToken,
          cwd: process.cwd(),
          resolvedCwd: info.workingDirectory,
          currentVersion: CLI_VERSION,
          now: Date.now,
          fetchLatestTag: fetchLatestReleaseTag,
          writeStderr: (text) => {
            process.stderr.write(text);
          },
        }),
      ).pipe(Effect.ignoreCause);
