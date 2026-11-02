import { parseArgs } from "node:util";
import process from "node:process";
import { Console, Data, Effect, Fiber } from "effect";

export interface ReleaseAsset {
  path: string;
  name: string;
}

const TRIPLES = [
  "darwin_arm64",
  "darwin_amd64",
  "linux_arm64",
  "linux_amd64",
  "windows_arm64",
  "windows_amd64",
] as const;

/** Every file the publish job attaches to a GitHub Release, in upload order. */
export function releaseAssets(version: string): ReleaseAsset[] {
  const paths = [
    ...TRIPLES.map((triple) => `dist/supabase_${version}_${triple}.tar.gz`),
    `dist/supabase_${version}_linux_arm64.deb`,
    `dist/supabase_${version}_linux_amd64.deb`,
    `dist/supabase_${version}_linux_arm64.rpm`,
    `dist/supabase_${version}_linux_amd64.rpm`,
    `dist/supabase_${version}_linux_arm64.apk`,
    `dist/supabase_${version}_linux_amd64.apk`,
    `dist/supabase_${version}_windows_amd64.zip`,
    `dist/supabase_${version}_windows_arm64.zip`,
    "dist/checksums.txt",
    // setup-cli, the install script, and docs download releases/latest/download/<unversioned>.
    ...TRIPLES.map((triple) => `dist/supabase_${triple}.tar.gz`),
    "install",
  ];
  return paths.map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) }));
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

class ReleaseAssetsError extends Data.TaggedError("ReleaseAssetsError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const toReleaseAssetsError = (cause: unknown) =>
  new ReleaseAssetsError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export interface ReleaseIo {
  run: (
    argv: string[],
    options: { timeoutMs: number },
  ) => Effect.Effect<RunResult, ReleaseAssetsError>;
  fileExists: (path: string) => Effect.Effect<boolean, ReleaseAssetsError>;
  sleep: (ms: number) => Effect.Effect<void>;
  log: (line: string) => Effect.Effect<void>;
}

export interface RetryPolicy {
  maxAttempts: number;
  timeoutMs: number;
  backoffMs: (failedAttempts: number) => number;
}

// gh retries a failed asset three times within a second on 5xx or a dropped connection. This
// outer policy covers the longer stalls uploads.github.com produces and the --clobber delete,
// which gh does not retry. Background: apps/cli/docs/release-process.md.
export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  timeoutMs: 300_000,
  backoffMs: (failedAttempts) => failedAttempts * 10_000,
};

function describeFailure(result: RunResult, timeoutMs: number): string {
  if (result.timedOut) return `timed out after ${timeoutMs / 1000}s`;
  const detail = result.stderr.trim().split("\n").at(-1) ?? "";
  return detail ? `exit ${result.exitCode}: ${detail}` : `exit ${result.exitCode}`;
}

/** Uploads each asset in turn, retrying per asset, and throws on the first asset that never lands. */
export const uploadAssets = Effect.fnUntraced(function* (
  tag: string,
  assets: ReleaseAsset[],
  io: ReleaseIo,
  policy: RetryPolicy = defaultRetryPolicy,
) {
  for (const asset of assets) {
    if (!(yield* io.fileExists(asset.path))) {
      return yield* new ReleaseAssetsError({
        message: `Release asset ${asset.path} does not exist.`,
      });
    }
    for (let attempt = 1; ; attempt++) {
      const result = yield* io.run(["gh", "release", "upload", tag, asset.path, "--clobber"], {
        timeoutMs: policy.timeoutMs,
      });
      if (result.exitCode === 0) {
        yield* io.log(`Uploaded ${asset.name} (attempt ${attempt}).`);
        break;
      }
      const failure = describeFailure(result, policy.timeoutMs);
      if (attempt >= policy.maxAttempts) {
        return yield* new ReleaseAssetsError({
          message: `Upload of ${asset.name} to ${tag} failed after ${attempt} attempts (${failure}).`,
        });
      }
      const delayMs = policy.backoffMs(attempt);
      yield* io.log(
        `Upload of ${asset.name} failed on attempt ${attempt} (${failure}); retrying in ${delayMs / 1000}s.`,
      );
      yield* io.sleep(delayMs);
    }
  }
});

interface ReleaseAssetView {
  name: string;
  state: string;
}

/** Names of the release's assets that GitHub reports as fully uploaded. */
export const uploadedAssetNames = Effect.fnUntraced(function* (tag: string, io: ReleaseIo) {
  const result = yield* io.run(["gh", "release", "view", tag, "--json", "assets"], {
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    return yield* new ReleaseAssetsError({
      message: `Could not read assets of ${tag} (${describeFailure(result, 60_000)}).`,
    });
  }
  return (yield* Effect.try({
    try: () => parseAssetView(result.stdout, tag),
    catch: toReleaseAssetsError,
  }))
    .filter((asset) => asset.state === "uploaded")
    .map((asset) => asset.name);
});

function isAssetView(value: unknown): value is ReleaseAssetView {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { state?: unknown }).state === "string"
  );
}

function parseAssetView(stdout: string, tag: string): ReleaseAssetView[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Could not read assets of ${tag}: gh returned invalid JSON.`);
  }
  const assets = (parsed as { assets?: unknown } | null)?.assets;
  if (!Array.isArray(assets) || !assets.every(isAssetView)) {
    throw new Error(
      `Could not read assets of ${tag}: gh output has no assets array with name and state.`,
    );
  }
  return assets;
}

/** Expected asset names that are absent from the uploaded set, sorted. */
export function missingAssets(expected: string[], uploaded: string[]): string[] {
  const present = new Set(uploaded);
  return expected.filter((name) => !present.has(name)).sort();
}

const usage = `Usage: bun apps/cli/scripts/upload-release-assets.ts <upload|verify> --version <version>

  upload  Upload every release asset to the draft release v<version>, one at a time with retries.
  verify  Fail unless every expected asset is present on v<version> and reported as uploaded.`;

export const main = Effect.fnUntraced(function* (argv: string[], io: ReleaseIo) {
  const { values, positionals } = yield* Effect.try({
    try: () =>
      parseArgs({
        args: argv,
        options: { version: { type: "string" } },
        allowPositionals: true,
      }),
    catch: toReleaseAssetsError,
  });
  const [command] = positionals;
  if (!values.version || (command !== "upload" && command !== "verify")) {
    yield* io.log(usage);
    return 2;
  }
  const tag = `v${values.version}`;
  const assets = releaseAssets(values.version);

  if (command === "upload") {
    yield* uploadAssets(tag, assets, io);
    return 0;
  }

  const missing = missingAssets(
    assets.map((asset) => asset.name),
    yield* uploadedAssetNames(tag, io),
  );
  if (missing.length > 0) {
    yield* io.log(`::error::Release ${tag} is missing assets or has incomplete uploads:`);
    for (const name of missing) yield* io.log(`  ${name}`);
    return 1;
  }
  yield* io.log(`All ${assets.length} expected assets are present on ${tag}.`);
  return 0;
});

/**
 * Time a timed-out command gets to exit on SIGTERM before it is killed outright, and the bound on
 * draining its pipes afterwards, since an orphaned descendant can hold them open.
 */
export const KILL_GRACE_MS = 5_000;

const within = (fiber: Fiber.Fiber<string, ReleaseAssetsError>, ms: number, fallback: string) =>
  Fiber.join(fiber).pipe(
    Effect.timeoutOrElse({ duration: ms, orElse: () => Effect.succeed(fallback) }),
  );

/** Runs a command with the given environment and terminates it once the timeout elapses. */
export function createSpawnRun(
  env: Record<string, string | undefined> = process.env,
): ReleaseIo["run"] {
  return Effect.fnUntraced(function* (argv: string[], { timeoutMs }: { timeoutMs: number }) {
    const child = yield* Effect.try({
      try: () => Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" }),
      catch: toReleaseAssetsError,
    });
    let timedOut = false;
    yield* Effect.sleep(timeoutMs).pipe(
      Effect.andThen(
        Effect.sync(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }),
      ),
      Effect.andThen(Effect.sleep(KILL_GRACE_MS)),
      Effect.andThen(Effect.sync(() => child.kill("SIGKILL"))),
      Effect.forkScoped({ startImmediately: true }),
    );
    // Start draining before the child exits so a chatty child never blocks on a full pipe.
    const stdoutText = yield* Effect.tryPromise({
      try: () => new Response(child.stdout).text(),
      catch: toReleaseAssetsError,
    }).pipe(Effect.forkScoped({ startImmediately: true }));
    const stderrText = yield* Effect.tryPromise({
      try: () => new Response(child.stderr).text(),
      catch: toReleaseAssetsError,
    }).pipe(Effect.forkScoped({ startImmediately: true }));
    const exitCode = yield* Effect.tryPromise({
      try: () => child.exited,
      catch: toReleaseAssetsError,
    });
    const [stdout, stderr] = yield* Effect.all(
      [within(stdoutText, KILL_GRACE_MS, ""), within(stderrText, KILL_GRACE_MS, "")],
      { concurrency: "unbounded" },
    );
    return { exitCode, stdout, stderr, timedOut };
  }, Effect.scoped);
}

export const processIo: ReleaseIo = {
  run: createSpawnRun(),
  fileExists: (path) =>
    Effect.tryPromise({ try: () => Bun.file(path).exists(), catch: toReleaseAssetsError }),
  sleep: (ms) => Effect.sleep(ms),
  log: (line) => Console.log(line),
};

if (import.meta.main) {
  process.exit(
    await Effect.runPromise(
      main(process.argv.slice(2), processIo).pipe(
        Effect.catch((error) => Console.error(`::error::${error.message}`).pipe(Effect.as(1))),
      ),
    ),
  );
}
