/**
 * Post-command upgrade notice: checks GitHub's latest release against the
 * running version and prints a notice to stderr, honoring
 * `SUPABASE_NO_UPDATE_NOTIFIER`. The tag is cached in the project's
 * `supabase/.temp/cli-latest`, else `<SUPABASE_HOME>/cli-latest`. A failed
 * fetch writes an empty cache as an offline backoff.
 */

import { stripVTControlCharacters } from "node:util";

import {
  Clock,
  Config,
  Data,
  Effect,
  FileSystem,
  Option,
  Path,
  Redacted,
  Result,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import {
  hasRootHelpOrVersionFlag,
  lastGlobalFlagValue,
  rootFlagTokens,
} from "../shared/cli/run.ts";
import { CLI_UPGRADE_GUIDE_URL, CLI_VERSION, parseSemver } from "../shared/cli/version.ts";
import { resolveSupabaseHomeValue } from "../shared/config/supabase-home.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { bold, yellow } from "./colors.ts";
import { parseDotEnv } from "./dotenv.ts";
import { candidateDotenvFilenames } from "./project-environment.ts";

const LATEST_RELEASE_URL = "https://api.github.com/repos/supabase/cli/releases/latest";
const CACHE_TTL_MS = 10 * 60 * 60 * 1000;
/** Bounds this pre-exit hook's latency. */
const FETCH_TIMEOUT_MS = 800;

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
  const latest = latestTag.startsWith("v") ? parseSemver(latestTag.slice(1)) : undefined;
  if (latest === undefined) return false;
  const current = parseSemver(currentVersion);
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

/** A failed release lookup; its message follows the `Failed to fetch latest release: ` prefix. */
export class UpgradeNoticeFetchError extends Data.TaggedError("UpgradeNoticeFetchError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

/** The underlying Node/Bun error's message when Effect wrapped one, else Effect's own. */
const causeMessage = (error: { readonly message: string; readonly cause?: unknown }): string =>
  error.cause instanceof Error ? error.cause.message : error.message;

/**
 * `lstat` through `FileSystem`, which only exposes `stat` and `readLink`: a
 * symlink at the final component is reported, never followed; any other path
 * gets its `stat`, which equals its `lstat`. `None` when it can't be read.
 */
const lstatEntry = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<Option.Option<"symlink" | FileSystem.File.Info>> =>
  fs.readLink(path).pipe(
    Effect.as(Option.some<"symlink" | FileSystem.File.Info>("symlink")),
    Effect.catch(() => fs.stat(path).pipe(Effect.option)),
  );

const isDirectoryEntry = (entry: Option.Option<"symlink" | FileSystem.File.Info>): boolean =>
  Option.isSome(entry) && entry.value !== "symlink" && entry.value.type === "Directory";

/** Absent (we may create it) or a real directory — never a symlink to follow. */
const isRealDirOrAbsent = (fs: FileSystem.FileSystem, path: string) =>
  lstatEntry(fs, path).pipe(Effect.map((entry) => Option.isNone(entry) || isDirectoryEntry(entry)));

/** UTF-8 that keeps a leading BOM, which `readFileString` strips. */
const readUtf8 = (fs: FileSystem.FileSystem, path: string) =>
  fs
    .readFile(path)
    .pipe(Effect.map((bytes) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)));

/**
 * The final entry stays link-safe without `O_NOFOLLOW` (CWE-59): removing it deletes a planted link,
 * never its target, and `wx` refuses whatever appears afterwards, such as a concurrent run's fresh
 * cache. The parent directories only get the advisory checks.
 */
const writeCacheFile = Effect.fnUntraced(function* (cacheFile: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .remove(cacheFile)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
  yield* fs
    .writeFileString(cacheFile, contents, { flag: "wx", mode: 0o644 })
    .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void));
});

/**
 * The directory `supabase/.temp` resolves against, matching
 * `command-settings.layer.ts`'s `resolveWorkdir` precedence. Not reused from
 * there: that resolution lives inside a command's own layer stack, and this
 * hook also runs for `--help`/`--version`, which never build one.
 */
const resolveNoticeBaseDir = Effect.fnUntraced(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  isValueTakingFlagToken?: (token: string) => boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A set flag beats the env even when empty; an empty effective value falls
  // through to the ancestor walk.
  const flagValue = lastGlobalFlagValue(args, "--workdir", isValueTakingFlagToken);
  const explicit = flagValue !== undefined ? flagValue : env["SUPABASE_WORKDIR"];
  if (explicit !== undefined && explicit !== "") {
    return path.resolve(cwd, explicit);
  }
  let current = cwd;
  while (true) {
    const configToml = path.join(current, "supabase", "config.toml");
    if (yield* fs.exists(configToml).pipe(Effect.orElseSucceed(() => false))) return current;
    const parent = path.dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
});

/**
 * The project dotenv chain as a merged map: `<base>/supabase` then `<base>`,
 * first file to define a key wins, shell env always beats a chain value —
 * same precedence as `resolveProjectEnvironmentValues`. Read for every real
 * command since this hook can't tell whether the command loads config; the
 * only effect is a suppressed notice or extra debug diagnostic either way.
 */
const projectDotenvValues = Effect.fnUntraced(function* (
  base: string,
  env: Readonly<Record<string, string | undefined>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const merged: Record<string, string> = {};
  // Loads `<base>/supabase` then `<base>`, except at the filesystem root,
  // where only `<base>/supabase` is read.
  const dirs =
    path.dirname(base) === base
      ? [path.join(base, "supabase")]
      : [path.join(base, "supabase"), base];
  for (const dir of dirs) {
    for (const filename of candidateDotenvFilenames(env["SUPABASE_ENV"] || "development")) {
      const contents = yield* readUtf8(fs, path.join(dir, filename)).pipe(Effect.option);
      if (Option.isNone(contents)) continue;
      const parsed = Result.try(() => parseDotEnv(contents.value));
      // A malformed file is only reachable here when the command never
      // loaded config — a load would have failed the run before this hook.
      if (Result.isFailure(parsed)) return {};
      for (const [key, value] of Object.entries(parsed.success)) {
        if (!(key in merged)) merged[key] = value;
      }
    }
  }
  return merged;
});

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
  /** The cache directory when `<base>/supabase` is not a real directory. */
  readonly supabaseHome: string;
  readonly now: () => number;
  readonly fetchLatestTag: Effect.Effect<string, UpgradeNoticeFetchError>;
  readonly writeStderr: (text: string) => void;
}

/** The release-tag cache a check used, recorded on its trace span. */
export interface UpgradeCheckOutcome {
  readonly cache: "project" | "user" | "disabled";
  readonly cacheFresh: boolean;
}

/** Succeeds with `undefined` when the notifier is opted out. */
export const runUpgradeNotice = Effect.fnUntraced(function* (
  deps: UpgradeNoticeDeps,
): Effect.fn.Return<UpgradeCheckOutcome | undefined, never, FileSystem.FileSystem | Path.Path> {
  if (updateNotifierDisabled(deps.env["SUPABASE_NO_UPDATE_NOTIFIER"])) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // `--help`/`--version` and a bare group's clean ShowHelp resolve the cache
  // against the bare cwd, ignoring `--workdir`/`SUPABASE_WORKDIR` and the
  // ancestor walk, and never reach a config load that could pull the opt-out
  // from a project dotenv.
  const builtin =
    deps.cleanShowHelp === true || hasRootHelpOrVersionFlag(deps.args, deps.isValueTakingFlagToken);
  const base = builtin
    ? deps.cwd
    : (deps.resolvedCwd ??
      (yield* resolveNoticeBaseDir(deps.cwd, deps.args, deps.env, deps.isValueTakingFlagToken)));
  const projectEnv: Record<string, string> = builtin
    ? {}
    : yield* projectDotenvValues(base, deps.env);
  // A shell env that defines a key at all beats the project dotenv chain,
  // even when set to an empty or unparseable value.
  const effectiveEnv = (key: string): string | undefined =>
    deps.env[key] !== undefined ? deps.env[key] : projectEnv[key];
  if (updateNotifierDisabled(effectiveEnv("SUPABASE_NO_UPDATE_NOTIFIER"))) return;
  const debug = debugEnabled(deps, builtin, effectiveEnv("SUPABASE_DEBUG"));
  const supabaseDir = path.join(base, "supabase");
  const inProject = isDirectoryEntry(yield* lstatEntry(fs, supabaseDir));
  /* `resolve` drops a trailing `/` or `/.`, which would make the symlink check follow a symlinked home. */
  const cacheDir = inProject ? path.join(supabaseDir, ".temp") : path.resolve(deps.supabaseHome);
  const cacheFile = path.join(cacheDir, "cli-latest");

  // A hostile checkout can commit a symlink at any level of this well-known
  // path to clobber an arbitrary user-writable file (CWE-59), so a symlink
  // anywhere disables the cache. These checks are advisory only, since they
  // run before a fetch that can take `FETCH_TIMEOUT_MS`; see `writeCacheFile`
  // for the write-time guarantee.
  const cacheEntry = yield* lstatEntry(fs, cacheFile);
  const cachePathIsSafe =
    !(Option.isSome(cacheEntry) && cacheEntry.value === "symlink") &&
    (yield* isRealDirOrAbsent(fs, cacheDir));

  /* Only a non-symlink entry gets here, so its `stat` mtime is the file's own. */
  const cacheFresh =
    cachePathIsSafe &&
    Option.isSome(cacheEntry) &&
    cacheEntry.value !== "symlink" &&
    Option.isSome(cacheEntry.value.mtime) &&
    deps.now() <= cacheEntry.value.mtime.value.getTime() + CACHE_TTL_MS;

  let latestTag: string;
  if (!cacheFresh) {
    const fetched = yield* Effect.result(deps.fetchLatestTag);
    latestTag = Result.isSuccess(fetched) ? fetched.success : "";
    let notifyError = Result.isFailure(fetched)
      ? `Failed to fetch latest release: ${fetched.failure.message}`
      : undefined;
    // The offline-backoff write's result overwrites the fetch error, so a
    // successful write silences the diagnostic; only an unsafe cache path (no
    // backoff) or a failing write leaves an error to log.
    if (cachePathIsSafe) {
      const tag = latestTag;
      notifyError = yield* fs.makeDirectory(cacheDir, { recursive: true, mode: 0o755 }).pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed(`failed to mkdir: ${causeMessage(error)}`),
          onSuccess: () =>
            writeCacheFile(cacheFile, tag).pipe(
              Effect.match({
                onFailure: (error) => `failed to write file: ${causeMessage(error)}`,
                onSuccess: () => undefined,
              }),
            ),
        }),
      );
    }
    if (notifyError !== undefined && debug) {
      const message = notifyError;
      yield* Effect.sync(() => deps.writeStderr(`${stripVTControlCharacters(message)}\n`));
    }
  } else {
    latestTag = yield* readUtf8(fs, cacheFile).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (debug) {
            deps.writeStderr(
              `failed to read cli version: ${stripVTControlCharacters(causeMessage(error))}\n`,
            );
          }
          return "";
        }),
      ),
    );
  }

  // Gated on the anchored semver match: no escape bytes can reach the terminal.
  if (isNewerCliVersion(latestTag, deps.currentVersion)) {
    const notice = formatUpgradeNotice(latestTag, deps.currentVersion);
    yield* Effect.sync(() => deps.writeStderr(`${notice}\n`));
  }
  return { cache: cachePathIsSafe ? (inProject ? "project" : "user") : "disabled", cacheFresh };
});

/** The `--debug` diagnostic for a lookup cut off at `FETCH_TIMEOUT_MS`. */
const FETCH_TIMEOUT_MESSAGE = "The operation timed out.";

/** A release whose `tag_name` is a string; any other body reads as no tag. */
const ReleaseBody = Schema.Struct({ tag_name: Schema.String });

/**
 * The GitHub latest-release lookup, bounded by `FETCH_TIMEOUT_MS` across the
 * request and its body. HttpClient tracing is off so the lookup adds no span
 * or `traceparent` header of its own.
 */
const fetchLatestReleaseTag: Effect.Effect<string, UpgradeNoticeFetchError, HttpClient.HttpClient> =
  Effect.gen(function* () {
    // Authenticates when GITHUB_TOKEN is set, for the higher rate limit on
    // shared-egress CI runners.
    const token = yield* Config.option(Config.Redacted("GITHUB_TOKEN"));
    const request = HttpClientRequest.get(LATEST_RELEASE_URL).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/vnd.github+json",
        "user-agent": `SupabaseCLI/${CLI_VERSION}`,
      }),
    );
    const response = yield* HttpClient.execute(
      Option.isSome(token) && Redacted.value(token.value) !== ""
        ? HttpClientRequest.bearerToken(request, token.value)
        : request,
    );
    if (response.status < 200 || response.status > 299) {
      return yield* new UpgradeNoticeFetchError({
        message: `unexpected status ${response.status}`,
      });
    }
    const body = yield* response.json;
    return yield* Schema.decodeUnknownEffect(ReleaseBody)(body).pipe(
      Effect.map((release) => release.tag_name),
      Effect.orElseSucceed(() => ""),
    );
  }).pipe(
    Effect.catchTags({
      ConfigError: (error) => Effect.fail(new UpgradeNoticeFetchError({ message: error.message })),
      HttpClientError: (error) =>
        Effect.fail(new UpgradeNoticeFetchError({ message: causeMessage(error) })),
    }),
    Effect.timeoutOrElse({
      duration: FETCH_TIMEOUT_MS,
      orElse: () => Effect.fail(new UpgradeNoticeFetchError({ message: FETCH_TIMEOUT_MESSAGE })),
    }),
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
  );

/** The `SUPABASE_*` keys the notice reads, from the ambient `Config` provider. */
const NOTICE_ENV_KEYS = [
  "SUPABASE_NO_UPDATE_NOTIFIER",
  "SUPABASE_DEBUG",
  "SUPABASE_WORKDIR",
  "SUPABASE_ENV",
];

/**
 * The `runCli` post-success hook. A defect (a throwing stderr write) is not a
 * typed failure, so `Effect.ignoreCause` (not `ignore`) keeps this unable to fail.
 */
export const upgradeNoticeHook = (
  args: ReadonlyArray<string>,
  info: {
    readonly cleanShowHelp: boolean;
    readonly delegatedToGo: boolean;
    readonly workingDirectory?: string;
    readonly isValueTakingFlagToken: (token: string) => boolean;
  },
  fetchLatestTag: Effect.Effect<
    string,
    UpgradeNoticeFetchError,
    HttpClient.HttpClient
  > = fetchLatestReleaseTag,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path | RuntimeInfo> =>
  info.delegatedToGo
    ? Effect.void
    : Effect.gen(function* () {
        const path = yield* Path.Path;
        const clock = yield* Clock.Clock;
        const runtime = yield* RuntimeInfo;
        const env: Record<string, string | undefined> = {};
        for (const key of NOTICE_ENV_KEYS) {
          env[key] = Option.getOrUndefined(yield* Config.option(Config.String(key)));
        }
        const supabaseHome = yield* Config.option(Config.String("SUPABASE_HOME"));
        const outcome = yield* runUpgradeNotice({
          env,
          args,
          cleanShowHelp: info.cleanShowHelp,
          isValueTakingFlagToken: info.isValueTakingFlagToken,
          cwd: runtime.cwd,
          resolvedCwd: info.workingDirectory,
          currentVersion: CLI_VERSION,
          supabaseHome: resolveSupabaseHomeValue(path, supabaseHome, runtime.homeDir),
          now: () => clock.currentTimeMillisUnsafe(),
          /* Runs inside the check span, so the fetch is its child span. */
          fetchLatestTag: fetchLatestTag.pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.withSpan("UpgradeNotice.fetch"),
          ),
          writeStderr: (text) => {
            process.stderr.write(text);
          },
        });
        if (outcome !== undefined) {
          yield* Effect.annotateCurrentSpan({
            "cache.location": outcome.cache,
            "cache.hit": outcome.cacheFresh,
          });
        }
      }).pipe(Effect.withSpan("UpgradeNotice.check"), Effect.ignoreCause);
