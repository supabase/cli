/**
 * Post-command upgrade notice: checks GitHub's latest release against the
 * running version and prints a notice to stderr, honoring
 * `SUPABASE_NO_UPDATE_NOTIFIER`. A failed fetch writes an empty cache as an
 * offline backoff.
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
} from "../shared/cli/run.ts";
import { CLI_UPGRADE_GUIDE_URL, CLI_VERSION } from "../shared/cli/version.ts";
import { bold, yellow } from "./colors.ts";
import { parseDotEnv } from "./dotenv.ts";
import { candidateDotenvFilenames } from "./project-environment.ts";

const LATEST_RELEASE_URL = "https://api.github.com/repos/supabase/cli/releases/latest";
const CACHE_TTL_MS = 10 * 60 * 60 * 1000;
/** Bounds this pre-exit hook's latency. */
const FETCH_TIMEOUT_MS = 3000;

/** Recognized "true" spellings; anything else, including garbage, leaves the notifier on. */
const PARSE_BOOL_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);

export function updateNotifierDisabled(value: string | undefined): boolean {
  return value !== undefined && PARSE_BOOL_TRUE.has(value);
}

/**
 * `--debug`/`--debug=<bool>` when set (last occurrence wins, even for
 * built-ins like `--help`), else `SUPABASE_DEBUG` — but the env only applies
 * to a real command, not `--help`/`--version`/a bare group's help. The token
 * walk skips operands after `--` and values consumed by other flags.
 */
function debugEnabled(
  deps: UpgradeNoticeDeps,
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
 * An invalid latest tag (including the empty offline-cache sentinel) never
 * suggests an upgrade; an invalid current version always does.
 */
export function isNewerCliVersion(latestTag: string, currentVersion: string): boolean {
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

/** Semver-spec prerelease precedence: numeric identifiers compare numerically, so `beta.9 < beta.10`. */
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
 * Styling goes through `colors.ts`, not raw `styleText`, which paints escapes
 * unconditionally on Bun even under `NO_COLOR` or on piped stderr.
 */
export function formatUpgradeNotice(latestTag: string, currentVersion: string): string {
  return (
    `A new version of Supabase CLI is available: ${yellow(latestTag)} (currently installed v${currentVersion})\n` +
    `We recommend updating regularly for new features and bug fixes: ${bold(CLI_UPGRADE_GUIDE_URL)}`
  );
}

/**
 * Writes the cache file with `O_NOFOLLOW`, so the kernel refuses to follow a
 * symlink swapped in for the final path component between the earlier
 * `lstat` check and this write (CWE-59/TOCTOU) — a plain `writeFile` would
 * otherwise truncate an arbitrary user-writable target. The parent
 * directories only get a weaker advisory `lstat` check; Node has no `openat`.
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
 * The directory `supabase/.temp` resolves against, matching
 * `command-settings.layer.ts`'s `resolveWorkdir` precedence. Not reused from
 * there: that resolution lives inside a command's own layer stack, and this
 * hook also runs for `--help`/`--version`, which never build one.
 */
function resolveNoticeBaseDir(
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  isValueTakingFlagToken?: (token: string) => boolean,
): string {
  // A set flag beats the env even when empty; an empty effective value falls
  // through to the ancestor walk.
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
 * The project dotenv chain as a merged map: `<base>/supabase` then `<base>`,
 * first file to define a key wins, shell env always beats a chain value —
 * same precedence as `resolveProjectEnvironmentValues`. Read for every real
 * command since this hook can't tell whether the command loads config; the
 * only effect is a suppressed notice or extra debug diagnostic either way.
 */
async function projectDotenvValues(
  base: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  // Loads `<base>/supabase` then `<base>`, except at the filesystem root,
  // where only `<base>/supabase` is read.
  const dirs = dirname(base) === base ? [join(base, "supabase")] : [join(base, "supabase"), base];
  for (const dir of dirs) {
    for (const filename of candidateDotenvFilenames(env["SUPABASE_ENV"] || "development")) {
      const contents = await readFile(join(dir, filename), "utf8").catch(() => undefined);
      if (contents === undefined) continue;
      try {
        for (const [key, value] of Object.entries(parseDotEnv(contents))) {
          if (!(key in merged)) merged[key] = value;
        }
      } catch {
        // A malformed file is only reachable here when the command never
        // loaded config — a load would have failed the run before this hook.
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

export interface UpgradeNoticeDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly args: ReadonlyArray<string>;
  /** The exit-0 ShowHelp branch (bare group command), served without a resolved working directory. */
  readonly cleanShowHelp?: boolean;
  /** Value-taking-token predicate for this argv, so a token a local flag consumed (e.g. `login --name --debug`) is never read as a flag. */
  readonly isValueTakingFlagToken?: (token: string) => boolean;
  readonly cwd: string;
  readonly resolvedCwd?: string;
  readonly currentVersion: string;
  readonly now: () => number;
  readonly fetchLatestTag: () => Promise<string>;
  readonly writeStderr: (text: string) => void;
}

export async function runUpgradeNotice(deps: UpgradeNoticeDeps): Promise<void> {
  if (updateNotifierDisabled(deps.env["SUPABASE_NO_UPDATE_NOTIFIER"])) return;

  // `--help`/`--version` and a bare group's clean ShowHelp resolve the cache
  // against the bare cwd, ignoring `--workdir`/`SUPABASE_WORKDIR` and the
  // ancestor walk, and never reach a config load that could pull the opt-out
  // from a project dotenv.
  const builtin =
    deps.cleanShowHelp === true || hasRootHelpOrVersionFlag(deps.args, deps.isValueTakingFlagToken);
  const base = builtin
    ? deps.cwd
    : (deps.resolvedCwd ??
      resolveNoticeBaseDir(deps.cwd, deps.args, deps.env, deps.isValueTakingFlagToken));
  const projectEnv = builtin ? {} : await projectDotenvValues(base, deps.env);
  // A shell env that defines a key at all beats the project dotenv chain,
  // even when set to an empty or unparseable value.
  const effectiveEnv = (key: string): string | undefined =>
    deps.env[key] !== undefined ? deps.env[key] : projectEnv[key];
  if (updateNotifierDisabled(effectiveEnv("SUPABASE_NO_UPDATE_NOTIFIER"))) return;
  const debug = debugEnabled(deps, builtin, effectiveEnv("SUPABASE_DEBUG"));
  const supabaseDir = join(base, "supabase");
  const tempDir = join(supabaseDir, ".temp");
  const cacheFile = join(tempDir, "cli-latest");

  // A hostile checkout can commit a symlink at any level of this well-known
  // path to clobber an arbitrary user-writable file (CWE-59), so a symlink
  // anywhere disables the cache. These `lstat` checks are advisory only,
  // since they run before a fetch that can take `FETCH_TIMEOUT_MS`; see
  // `writeCacheFileNoFollow` for the write-time guarantee.
  const cacheLstat = await lstat(cacheFile).catch(() => undefined);
  const cachePathIsSafe =
    cacheLstat?.isSymbolicLink() !== true &&
    (await isRealDirOrAbsent(supabaseDir)) &&
    (await isRealDirOrAbsent(tempDir));

  // A subcommand's own `--version` must not bypass the cache.
  const forceFetch = hasRootVersionFlag(deps.args, deps.isValueTakingFlagToken);
  const cacheFresh =
    cachePathIsSafe &&
    cacheLstat !== undefined &&
    deps.now() <= cacheLstat.mtime.getTime() + CACHE_TTL_MS;

  let latestTag: string;
  if (forceFetch || !cacheFresh) {
    let notifyError: Error | undefined;
    latestTag = await deps.fetchLatestTag().catch((error: unknown) => {
      notifyError = new Error(`Failed to fetch latest release: ${errorMessage(error)}`);
      return "";
    });
    // The offline-backoff write's result overwrites the fetch error when
    // inside a project, so a successful write silences the diagnostic; only a
    // missing project (no backoff) or a failing write leaves an error to log.
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
  if (isNewerCliVersion(latestTag, deps.currentVersion)) {
    deps.writeStderr(`${formatUpgradeNotice(latestTag, deps.currentVersion)}\n`);
  }
}

async function fetchLatestReleaseTag(): Promise<string> {
  // Authenticates when GITHUB_TOKEN is set, for the higher rate limit on
  // shared-egress CI runners.
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
export const upgradeNoticeHook = (
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
        runUpgradeNotice({
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
