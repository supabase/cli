import { parseArgs } from "node:util";
import process from "node:process";

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

export interface ReleaseIo {
  run: (argv: string[], options: { timeoutMs: number }) => Promise<RunResult>;
  fileExists: (path: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
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
export async function uploadAssets(
  tag: string,
  assets: ReleaseAsset[],
  io: ReleaseIo,
  policy: RetryPolicy = defaultRetryPolicy,
): Promise<void> {
  for (const asset of assets) {
    if (!(await io.fileExists(asset.path))) {
      throw new Error(`Release asset ${asset.path} does not exist.`);
    }
    for (let attempt = 1; ; attempt++) {
      const result = await io.run(["gh", "release", "upload", tag, asset.path, "--clobber"], {
        timeoutMs: policy.timeoutMs,
      });
      if (result.exitCode === 0) {
        io.log(`Uploaded ${asset.name} (attempt ${attempt}).`);
        break;
      }
      const failure = describeFailure(result, policy.timeoutMs);
      if (attempt >= policy.maxAttempts) {
        throw new Error(
          `Upload of ${asset.name} to ${tag} failed after ${attempt} attempts (${failure}).`,
        );
      }
      const delayMs = policy.backoffMs(attempt);
      io.log(
        `Upload of ${asset.name} failed on attempt ${attempt} (${failure}); retrying in ${delayMs / 1000}s.`,
      );
      await io.sleep(delayMs);
    }
  }
}

interface ReleaseAssetView {
  name: string;
  state: string;
}

/** Names of the release's assets that GitHub reports as fully uploaded. */
export async function uploadedAssetNames(tag: string, io: ReleaseIo): Promise<string[]> {
  const result = await io.run(["gh", "release", "view", tag, "--json", "assets"], {
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not read assets of ${tag} (${describeFailure(result, 60_000)}).`);
  }
  const { assets } = JSON.parse(result.stdout) as { assets: ReleaseAssetView[] };
  return assets.filter((asset) => asset.state === "uploaded").map((asset) => asset.name);
}

/** Expected asset names that are absent from the uploaded set, sorted. */
export function missingAssets(expected: string[], uploaded: string[]): string[] {
  const present = new Set(uploaded);
  return expected.filter((name) => !present.has(name)).sort();
}

const usage = `Usage: pnpm exec bun apps/cli/scripts/upload-release-assets.ts <upload|verify> --version <version>

  upload  Upload every release asset to the draft release v<version>, one at a time with retries.
  verify  Fail unless every expected asset is present on v<version> and reported as uploaded.`;

export async function main(argv: string[], io: ReleaseIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { version: { type: "string" } },
    allowPositionals: true,
  });
  const [command] = positionals;
  if (!values.version || (command !== "upload" && command !== "verify")) {
    io.log(usage);
    return 2;
  }
  const tag = `v${values.version}`;
  const assets = releaseAssets(values.version);

  if (command === "upload") {
    await uploadAssets(tag, assets, io);
    return 0;
  }

  const missing = missingAssets(
    assets.map((asset) => asset.name),
    await uploadedAssetNames(tag, io),
  );
  if (missing.length > 0) {
    io.log(`::error::Release ${tag} is missing assets or has incomplete uploads:`);
    for (const name of missing) io.log(`  ${name}`);
    return 1;
  }
  io.log(`All ${assets.length} expected assets are present on ${tag}.`);
  return 0;
}

/** Runs a command with the given environment and terminates it once the timeout elapses. */
export function createSpawnRun(
  env: Record<string, string | undefined> = process.env,
): ReleaseIo["run"] {
  return async (argv, { timeoutMs }) => {
    const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const processIo: ReleaseIo = {
  run: createSpawnRun(),
  fileExists: (path) => Bun.file(path).exists(),
  sleep: (ms) => Bun.sleep(ms),
  log: (line) => console.log(line),
};

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2), processIo));
  } catch (cause) {
    console.error(`::error::${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  }
}
