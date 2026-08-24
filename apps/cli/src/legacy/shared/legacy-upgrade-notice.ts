/**
 * Port of Go's post-command upgrade notice (`cmd/root.go`'s `checkUpgrade`/
 * `shouldFetchRelease`/`suggestUpgrade`), with the `SUPABASE_NO_UPDATE_NOTIFIER`
 * opt-out from supabase/cli#5853. An empty cache written on a failed fetch is
 * Go's own offline backoff.
 */

import { stripVTControlCharacters } from "node:util";

import { BunServices } from "@effect/platform-bun";
import { Config, Data, Duration, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { FetchHttpClient } from "effect/unstable/http";

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
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

const LATEST_RELEASE_URL = "https://api.github.com/repos/supabase/cli/releases/latest";
const UPGRADE_GUIDE_URL =
  "https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli";
const CACHE_TTL_MS = 10 * 60 * 60 * 1000;
/** No Go equivalent (its client sets no timeout); bounds this pre-exit hook's latency. */
const FETCH_TIMEOUT_MS = 3000;

export class LegacyUpgradeNoticeError extends Data.TaggedError("LegacyUpgradeNoticeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

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
 * Write the offline cache without following a symlink at the final path component.
 * The pre-fetch and post-fetch link checks are advisory; this leaf adapter repeats
 * the invariant in the kernel after the network operation has completed. Node's
 * numeric open flags are used only at this foreign platform boundary; all callers
 * remain Effect-native and receive the operation's failure through the Effect error
 * channel.
 */
function writeCacheFileNoFollow(
  cacheFile: string,
  contents: string,
): Effect.Effect<void, LegacyUpgradeNoticeError> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        import("node:fs").then(({ constants: fsConstants }) =>
          import("node:fs/promises").then(({ open: openFile }) => {
            const flags =
              fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_TRUNC |
              (fsConstants.O_NOFOLLOW ?? 0);
            return openFile(cacheFile, flags, 0o644);
          }),
        ),
      catch: (cause) =>
        new LegacyUpgradeNoticeError({
          message: `failed to open cache file: ${errorMessage(cause)}`,
          cause,
        }),
    }),
    (handle) =>
      Effect.tryPromise({
        try: () => handle.writeFile(contents),
        catch: (cause) =>
          new LegacyUpgradeNoticeError({
            message: `failed to write cache file: ${errorMessage(cause)}`,
            cause,
          }),
      }),
    (handle) =>
      Effect.tryPromise({
        try: () => handle.close(),
        catch: () => undefined,
      }).pipe(Effect.ignore),
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
  fs: FileSystem.FileSystem,
  path: Path.Path,
  isValueTakingFlagToken?: (token: string) => boolean,
): Effect.Effect<string> {
  // Viper: a set flag beats the env even when empty, and an empty effective
  // value falls through to the ancestor walk (`ChangeWorkDir`'s own rule).
  const flagValue = lastGlobalFlagValue(args, "--workdir", isValueTakingFlagToken);
  const explicit = flagValue !== undefined ? flagValue : env["SUPABASE_WORKDIR"];
  if (explicit !== undefined && explicit !== "") {
    return Effect.succeed(path.resolve(cwd, explicit));
  }
  return Effect.gen(function* () {
    let current = cwd;
    while (true) {
      const exists = yield* fs
        .exists(path.join(current, "supabase", "config.toml"))
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) return current;
      const parent = path.dirname(current);
      if (parent === current) return cwd;
      current = parent;
    }
  });
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
function projectDotenvValues(
  base: string,
  env: Readonly<Record<string, string | undefined>>,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<Record<string, string>> {
  return Effect.gen(function* () {
    const merged: Record<string, string> = {};
    // Go's walk loads `<base>/supabase` then `<base>` — except at the filesystem
    // root, where `loadNestedEnv`'s `cwd != filepath.Dir(repoDir)` bound
    // degenerates (`Dir("/") == "/"`) and only `/supabase` is read.
    const dirs =
      path.dirname(base) === base
        ? [path.join(base, "supabase")]
        : [path.join(base, "supabase"), base];
    for (const dir of dirs) {
      for (const filename of legacyCandidateDotenvFilenames(env["SUPABASE_ENV"] || "development")) {
        const contents = yield* fs.readFileString(path.join(dir, filename)).pipe(Effect.option);
        if (Option.isNone(contents)) continue;
        const parsed = yield* Effect.try({
          try: () => parseDotEnv(contents.value),
          catch: (cause) => new LegacyUpgradeNoticeError({ message: "invalid dotenv", cause }),
        }).pipe(Effect.option);
        if (Option.isNone(parsed)) {
          // A malformed file is only reachable here when the command never
          // loaded config (a load would have failed the run before this hook),
          // and then Go never read any of the chain either.
          return {};
        }
        for (const [key, value] of Object.entries(parsed.value)) {
          if (!(key in merged)) merged[key] = value;
        }
      }
    }
    return merged;
  });
}

/** Absent (we may create it) or a real directory — never a symlink to follow. */
function isRealDirOrAbsent(path: string, fs: FileSystem.FileSystem): Effect.Effect<boolean> {
  return fs.readLink(path).pipe(
    Effect.as(false),
    Effect.orElseSucceed(() => true),
  );
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
  readonly fetchLatestTag: Effect.Effect<string, LegacyUpgradeNoticeError>;
  readonly writeStderr: (text: string) => void;
}

export const legacyRunUpgradeNotice = Effect.fnUntraced(function* (deps: LegacyUpgradeNoticeDeps) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
      (yield* resolveNoticeBaseDir(
        deps.cwd,
        deps.args,
        deps.env,
        fs,
        path,
        deps.isValueTakingFlagToken,
      )));
  const projectEnv = builtin ? {} : yield* projectDotenvValues(base, deps.env, fs, path);
  // godotenv never overrides: a shell env that defines a key at all beats the
  // project dotenv chain, even when set to an empty or unparseable value.
  const effectiveEnv = (key: string): string | undefined =>
    deps.env[key] !== undefined ? deps.env[key] : projectEnv[key];
  if (legacyUpdateNotifierDisabled(effectiveEnv("SUPABASE_NO_UPDATE_NOTIFIER"))) return;
  const debug = debugEnabled(deps, builtin, effectiveEnv("SUPABASE_DEBUG"));
  const supabaseDir = path.join(base, "supabase");
  const tempDir = path.join(supabaseDir, ".temp");
  const cacheFile = path.join(tempDir, "cli-latest");

  // A hostile checkout can commit a symlink at any level of this well-known
  // path to clobber an arbitrary user-writable file (CWE-59): a symlink
  // anywhere disables the cache. Do not relax to `stat`/`existsSync`, which
  // follow links. These checks are advisory only — they run before a fetch that
  // can take FETCH_TIMEOUT_MS, so the cache file is checked again immediately
  // before writing.
  const cacheSymlink = yield* fs.readLink(cacheFile).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  const cacheLstat = cacheSymlink
    ? Option.none<FileSystem.File.Info>()
    : yield* fs.stat(cacheFile).pipe(Effect.option);
  const cachePathIsSafe =
    !cacheSymlink &&
    (yield* isRealDirOrAbsent(supabaseDir, fs)) &&
    (yield* isRealDirOrAbsent(tempDir, fs));

  // Go's `rootCmd.Flag("version").Changed` — a subcommand's own `--version` must not bypass the cache.
  const forceFetch = hasRootVersionFlag(deps.args, deps.isValueTakingFlagToken);
  const cacheFresh =
    cachePathIsSafe &&
    Option.isSome(cacheLstat) &&
    Option.isSome(cacheLstat.value.mtime) &&
    deps.now() <= cacheLstat.value.mtime.value.getTime() + CACHE_TTL_MS;

  let latestTag: string;
  if (forceFetch || !cacheFresh) {
    let notifyError: LegacyUpgradeNoticeError | undefined;
    const fetched = yield* deps.fetchLatestTag.pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (tag) => ({ ok: true as const, tag }),
      }),
    );
    if (fetched.ok) {
      latestTag = fetched.tag;
    } else {
      // Go's `GetLatestRelease` wrap (`internal/utils/release.go:42`) —
      // capital F and all.
      notifyError = new LegacyUpgradeNoticeError({
        message: `Failed to fetch latest release: ${errorMessage(fetched.error)}`,
        cause: fetched.error,
      });
      latestTag = "";
    }
    // Go's `checkUpgrade` (`cmd/root.go:254-258`) overwrites the fetch error
    // with the offline-backoff write's result when inside a project, so a
    // successful write silences the diagnostic — only a missing project (no
    // backoff) or a failing write leaves an error to log, carrying the write
    // path's own wraps (`failed to mkdir`/`failed to write file`, misc.go).
    const supabaseExists = yield* fs.exists(supabaseDir).pipe(Effect.orElseSucceed(() => false));
    if (cachePathIsSafe && supabaseExists) {
      const mkdirError = yield* fs.makeDirectory(tempDir, { recursive: true, mode: 0o755 }).pipe(
        Effect.match({
          onFailure: (error) =>
            new LegacyUpgradeNoticeError({
              message: `failed to mkdir: ${errorMessage(error)}`,
              cause: error,
            }),
          onSuccess: () => undefined,
        }),
      );
      if (mkdirError !== undefined) {
        notifyError = mkdirError;
      } else {
        const symlinkAfterFetch = yield* fs.readLink(cacheFile).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (!symlinkAfterFetch) {
          notifyError = yield* writeCacheFileNoFollow(cacheFile, latestTag).pipe(
            Effect.match({
              onFailure: (error) =>
                new LegacyUpgradeNoticeError({
                  message: `failed to write file: ${errorMessage(error)}`,
                  cause: error,
                }),
              onSuccess: () => undefined,
            }),
          );
        }
      }
    }
    if (notifyError !== undefined && debug) {
      deps.writeStderr(`${stripVTControlCharacters(notifyError.message)}\n`);
    }
  } else {
    latestTag = yield* fs.readFileString(cacheFile).pipe(
      Effect.match({
        onFailure: (error) => {
          if (debug) {
            deps.writeStderr(
              `failed to read cli version: ${stripVTControlCharacters(errorMessage(error))}\n`,
            );
          }
          return "";
        },
        onSuccess: (value) => value,
      }),
    );
  }

  // Gated on the anchored semver match: no escape bytes can reach the terminal.
  if (legacyIsNewerCliVersion(latestTag, deps.currentVersion)) {
    deps.writeStderr(`${legacyFormatUpgradeNotice(latestTag, deps.currentVersion)}\n`);
  }
});

const LatestReleaseSchema = Schema.Struct({ tag_name: Schema.optional(Schema.String) });
const decodeLatestRelease = Schema.decodeUnknownEffect(LatestReleaseSchema);

function fetchLatestReleaseTag(
  token: string | undefined,
): Effect.Effect<string, LegacyUpgradeNoticeError, HttpClient.HttpClient> {
  // Go's `GetGitHubClient` authenticates when GITHUB_TOKEN is set, for the
  // higher rate limit on shared-egress CI runners.
  let request = HttpClientRequest.get(LATEST_RELEASE_URL).pipe(
    HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
    HttpClientRequest.setHeader("user-agent", `SupabaseCLI/${CLI_VERSION}`),
  );
  if (token !== undefined && token !== "") {
    request = request.pipe(HttpClientRequest.setHeader("authorization", `Bearer ${token}`));
  }
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(request);
    if (response.status < 200 || response.status >= 300) {
      return yield* new LegacyUpgradeNoticeError({
        message: `unexpected status ${response.status}`,
      });
    }
    const body = yield* response.json;
    const decoded = yield* decodeLatestRelease(body).pipe(
      Effect.orElseSucceed(() => ({ tag_name: undefined })),
    );
    return decoded.tag_name ?? "";
  }).pipe(
    Effect.timeout(Duration.millis(FETCH_TIMEOUT_MS)),
    Effect.mapError((cause) =>
      cause instanceof LegacyUpgradeNoticeError
        ? cause
        : new LegacyUpgradeNoticeError({
            message: `failed to fetch latest release: ${errorMessage(cause)}`,
            cause,
          }),
    ),
  );
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
  (info.delegatedToGo
    ? Effect.void
    : Effect.gen(function* () {
        const configured = yield* Effect.all({
          noUpdateNotifier: Config.option(Config.string("SUPABASE_NO_UPDATE_NOTIFIER")),
          workdir: Config.option(Config.string("SUPABASE_WORKDIR")),
          environment: Config.option(Config.string("SUPABASE_ENV")),
          debug: Config.option(Config.string("SUPABASE_DEBUG")),
          githubToken: Config.option(Config.string("GITHUB_TOKEN")),
        });
        const env: Readonly<Record<string, string | undefined>> = {
          SUPABASE_NO_UPDATE_NOTIFIER: Option.getOrUndefined(configured.noUpdateNotifier),
          SUPABASE_WORKDIR: Option.getOrUndefined(configured.workdir),
          SUPABASE_ENV: Option.getOrUndefined(configured.environment),
          SUPABASE_DEBUG: Option.getOrUndefined(configured.debug),
        };
        yield* legacyRunUpgradeNotice({
          env,
          args,
          cleanShowHelp: info.cleanShowHelp,
          isValueTakingFlagToken: info.isValueTakingFlagToken,
          cwd: process.cwd(),
          resolvedCwd: info.workingDirectory,
          currentVersion: CLI_VERSION,
          now: Date.now,
          fetchLatestTag: fetchLatestReleaseTag(Option.getOrUndefined(configured.githubToken)).pipe(
            Effect.provide(FetchHttpClient.layer),
          ),
          writeStderr: (text) => {
            process.stderr.write(text);
          },
        });
      }).pipe(Effect.ignoreCause)
  ).pipe(Effect.provide(BunServices.layer));
