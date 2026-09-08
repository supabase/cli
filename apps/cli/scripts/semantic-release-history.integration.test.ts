import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semanticRelease, { type Result } from "semantic-release";
import { afterEach, describe, expect, test } from "vitest";
import { filterCommitsToPackage } from "../../../packages/config/scripts/semantic-release-path-filter.ts";
import { HISTORICAL_INTERVALS, TRAINS } from "./fixtures/release-history.fixtures.ts";

const CHARACTERIZATION_PLUGIN = fileURLToPath(
  new URL("./fixtures/semantic-release-characterization-plugin.js", import.meta.url),
);
const CURRENT_CONFIG_PLUGIN = fileURLToPath(
  new URL("../../../packages/config/scripts/semantic-release-path-filter.ts", import.meta.url),
);
const GIT_CONFIG = [
  "-c",
  "user.name=release-characterization",
  "-c",
  "user.email=release-characterization@supabase.local",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
];

interface History {
  readonly root: string;
  readonly repo: string;
  readonly origin: string;
  readonly legacyTag: string;
  readonly baselineSha: string;
  nextFile: number;
}

interface RunOptions {
  readonly tagFormat: string;
  readonly train: "cli" | "config";
  readonly branches?: ReadonlyArray<
    string | { readonly name: string; readonly prerelease: string; readonly channel: string }
  >;
  readonly plugin?: string;
}

const temporaryRoots: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...GIT_CONFIG, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed with exit code ${exitCode}: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function gitExitCode(cwd: string, args: readonly string[]): Promise<number> {
  const proc = Bun.spawn(["git", ...GIT_CONFIG, ...args], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited;
}

async function createHistory(legacyTag: string): Promise<History> {
  const root = await mkdtemp(join(tmpdir(), "semantic-release-history-"));
  temporaryRoots.push(root);
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  await mkdir(repo);
  await git(root, ["init", "--bare", "-q", origin]);
  await git(repo, ["init", "-b", "main", "-q"]);
  await writeFile(
    join(repo, "package.json"),
    '{"name":"release-characterization","version":"0.0.0"}\n',
  );
  await git(repo, ["add", "package.json"]);
  await git(repo, ["commit", "-m", "chore: establish release baseline"]);
  const baselineSha = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["tag", legacyTag]);
  await git(repo, ["remote", "add", "origin", pathToFileURL(origin).href]);
  await git(repo, ["push", "-u", "origin", "main", "--tags"]);
  await git(repo, ["checkout", "-b", "develop", "-q"]);
  await git(repo, ["push", "-u", "origin", "develop"]);
  return { root, repo, origin, legacyTag, baselineSha, nextFile: 0 };
}

async function commit(
  history: History,
  message: string,
  path = "apps/cli/release-characterization.ts",
): Promise<string> {
  const fullPath = join(history.repo, path);
  await mkdir(dirname(fullPath), { recursive: true });
  history.nextFile += 1;
  await writeFile(fullPath, `export const revision = ${history.nextFile};\n`);
  await git(history.repo, ["add", path]);
  await git(history.repo, ["commit", "-m", message]);
  return git(history.repo, ["rev-parse", "HEAD"]);
}

async function pushCurrentBranch(history: History): Promise<void> {
  await git(history.repo, ["push", "origin", "HEAD"]);
}

async function tagRelease(
  history: History,
  tag: string,
  channel?: "beta" | "latest",
): Promise<void> {
  await git(history.repo, ["tag", tag]);
  if (channel) {
    const noteChannel = channel === "latest" ? null : channel;
    await git(history.repo, [
      "notes",
      "--ref",
      "semantic-release",
      "add",
      "-f",
      "-m",
      JSON.stringify({ channels: [noteChannel] }),
      `${tag}^{commit}`,
    ]);
    await git(history.repo, ["push", "origin", "refs/notes/semantic-release"]);
  }
  await git(history.repo, ["push", "origin", `refs/tags/${tag}`]);
}

function releaseEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    "CI",
    "GITHUB_ACTIONS",
    "GITHUB_REF",
    "GITHUB_REF_NAME",
    "GITHUB_HEAD_REF",
    "GITHUB_BASE_REF",
    "GITHUB_EVENT_NAME",
  ]) {
    delete env[name];
  }
  return env;
}

async function runRelease(history: History, options: RunOptions): Promise<Result> {
  return semanticRelease(
    {
      branches: options.branches ?? [
        "main",
        { name: "develop", prerelease: "beta", channel: "beta" },
      ],
      tagFormat: options.tagFormat,
      repositoryUrl: pathToFileURL(history.origin).href,
      dryRun: true,
      noCi: true,
      plugins: [[options.plugin ?? CHARACTERIZATION_PLUGIN, { train: options.train }]],
    },
    { cwd: history.repo, env: releaseEnvironment() },
  );
}

function expectRelease(
  result: Result,
  version: string,
  gitTag: string,
): asserts result is Exclude<Result, false> {
  expect(result).not.toBe(false);
  if (result === false) {
    throw new Error("semantic-release unexpectedly reported no release");
  }
  expect(result.nextRelease.version).toBe(version);
  expect(result.nextRelease.gitTag).toBe(gitTag);
}

async function withCompatibilityTags<T>(
  history: History,
  tags: ReadonlyArray<{ readonly name: string; readonly target: string }>,
  effect: () => Promise<T>,
): Promise<T> {
  const legacyTargetBefore = await git(history.repo, [
    "rev-parse",
    `refs/tags/${history.legacyTag}`,
  ]);
  for (const tag of tags) {
    await git(history.repo, ["tag", tag.name, tag.target]);
  }
  try {
    return await effect();
  } finally {
    for (const tag of tags) {
      await git(history.repo, ["tag", "-d", tag.name]);
    }
    expect(await git(history.repo, ["rev-parse", `refs/tags/${history.legacyTag}`])).toBe(
      legacyTargetBefore,
    );
  }
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe.each(TRAINS)("$train namespaced release history", (train) => {
  const selectedPath =
    train.train === "config"
      ? "packages/config/src/release-characterization.ts"
      : "apps/cli/release-characterization.ts";
  const tagFormat = `${train.namespace}\${version}`;

  test("moves from a legacy stable through two namespaced betas to a namespaced stable", async () => {
    const history = await createHistory(`${train.legacyPrefix}1.2.3`);
    await commit(history, "feat: add capability", selectedPath);
    await pushCurrentBranch(history);

    const firstBeta = await withCompatibilityTags(
      history,
      [{ name: `${train.namespace}1.2.3`, target: history.baselineSha }],
      () => runRelease(history, { train: train.train, tagFormat }),
    );
    expectRelease(firstBeta, "1.3.0-beta.1", `${train.namespace}1.3.0-beta.1`);
    expect(
      await gitExitCode(history.repo, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/tags/${train.namespace}1.2.3`,
      ]),
    ).toBe(1);

    await tagRelease(history, `${train.namespace}1.3.0-beta.1`, "beta");
    await commit(history, "fix: correct the beta", selectedPath);
    await pushCurrentBranch(history);
    const secondBeta = await runRelease(history, { train: train.train, tagFormat });
    expectRelease(secondBeta, "1.3.0-beta.2", `${train.namespace}1.3.0-beta.2`);

    await tagRelease(history, `${train.namespace}1.3.0-beta.2`, "beta");
    await git(history.repo, ["checkout", "main", "-q"]);
    await git(history.repo, ["merge", "--ff-only", "develop"]);
    await pushCurrentBranch(history);
    const stable = await withCompatibilityTags(
      history,
      [{ name: `${train.namespace}1.2.3`, target: history.baselineSha }],
      () => runRelease(history, { train: train.train, tagFormat }),
    );
    expectRelease(stable, "1.3.0", `${train.namespace}1.3.0`);

    expect(await git(history.repo, ["rev-parse", `refs/tags/${history.legacyTag}`])).toBe(
      history.baselineSha,
    );
    expect((await git(history.repo, ["tag", "--list", `${train.namespace}*`])).split("\n")).toEqual(
      [`${train.namespace}1.3.0-beta.1`, `${train.namespace}1.3.0-beta.2`],
    );
  }, 30_000);

  test("continues an active legacy beta at beta.2", async () => {
    const history = await createHistory(`${train.legacyPrefix}1.2.3`);
    const betaSha = await commit(history, "feat: add capability", selectedPath);
    await tagRelease(history, `${train.legacyPrefix}1.3.0-beta.1`, "beta");
    await commit(history, "fix: continue beta testing", selectedPath);
    await pushCurrentBranch(history);

    const result = await withCompatibilityTags(
      history,
      [
        { name: `${train.namespace}1.2.3`, target: history.baselineSha },
        { name: `${train.namespace}1.3.0-beta.1`, target: betaSha },
      ],
      () => runRelease(history, { train: train.train, tagFormat }),
    );

    expectRelease(result, "1.3.0-beta.2", `${train.namespace}1.3.0-beta.2`);
  });

  test("plans a reviewed stable hotfix directly from the legacy stable", async () => {
    const history = await createHistory(`${train.legacyPrefix}1.2.3`);
    await git(history.repo, ["checkout", "main", "-q"]);
    await commit(history, "fix: reviewed production hotfix", selectedPath);
    await pushCurrentBranch(history);

    const result = await withCompatibilityTags(
      history,
      [{ name: `${train.namespace}1.2.3`, target: history.baselineSha }],
      () => runRelease(history, { train: train.train, tagFormat }),
    );

    expectRelease(result, "1.2.4", `${train.namespace}1.2.4`);
  });

  test("characterizes major, patch, and no-release histories", async () => {
    for (const scenario of [
      { message: "chore!: replace the public contract", version: "2.0.0-beta.1" },
      { message: "fix: correct behavior", version: "1.2.4-beta.1" },
      { message: "docs: clarify behavior", version: null },
    ]) {
      const history = await createHistory(`${train.legacyPrefix}1.2.3`);
      await commit(history, scenario.message, selectedPath);
      await pushCurrentBranch(history);
      const result = await withCompatibilityTags(
        history,
        [{ name: `${train.namespace}1.2.3`, target: history.baselineSha }],
        () => runRelease(history, { train: train.train, tagFormat }),
      );
      if (scenario.version === null) {
        expect(result).toBe(false);
      } else {
        expectRelease(result, scenario.version, `${train.namespace}${scenario.version}`);
      }
    }
  }, 30_000);

  test("accepts legacy and namespaced stable tags on the same commit", async () => {
    const history = await createHistory(`${train.legacyPrefix}1.2.3`);
    await git(history.repo, ["tag", `${train.namespace}1.2.3`, history.baselineSha]);
    await git(history.repo, ["push", "origin", `refs/tags/${train.namespace}1.2.3`]);
    await commit(history, "fix: correct behavior", selectedPath);
    await pushCurrentBranch(history);

    const result = await runRelease(history, { train: train.train, tagFormat });

    expectRelease(result, "1.2.4-beta.1", `${train.namespace}1.2.4-beta.1`);
    expect(await git(history.repo, ["rev-parse", `refs/tags/${history.legacyTag}`])).toBe(
      history.baselineSha,
    );
  });

  test("fetches beta channel notes and differs when they are missing", async () => {
    const history = await createHistory(`${train.legacyPrefix}1.2.3`);
    await git(history.repo, ["tag", `${train.namespace}1.2.3`, history.baselineSha]);
    await git(history.repo, ["push", "origin", `refs/tags/${train.namespace}1.2.3`]);
    const betaSha = await commit(history, "feat: add capability", selectedPath);
    await tagRelease(history, `${train.namespace}1.3.0-beta.1`);
    await commit(history, "fix: continue beta testing", selectedPath);
    await pushCurrentBranch(history);

    const withoutNotes = await runRelease(history, { train: train.train, tagFormat });
    expectRelease(withoutNotes, "1.3.0-beta.1", `${train.namespace}1.3.0-beta.1`);

    await git(history.repo, [
      "notes",
      "--ref",
      "semantic-release",
      "add",
      "-f",
      "-m",
      JSON.stringify({ channels: ["beta"] }),
      betaSha,
    ]);
    await git(history.repo, ["push", "origin", "refs/notes/semantic-release"]);
    await git(history.repo, ["update-ref", "-d", "refs/notes/semantic-release"]);
    expect(
      await gitExitCode(history.repo, ["notes", "--ref", "semantic-release", "show", betaSha]),
    ).toBe(1);

    const withFetchedNotes = await runRelease(history, { train: train.train, tagFormat });
    expectRelease(withFetchedNotes, "1.3.0-beta.2", `${train.namespace}1.3.0-beta.2`);
  });
});

test("CLI and config histories diverge independently in the same repository", async () => {
  const history = await createHistory("v1.2.3");
  await git(history.repo, ["tag", "cli@1.2.3", history.baselineSha]);
  await git(history.repo, ["tag", "config@0.4.1", history.baselineSha]);
  await git(history.repo, ["push", "origin", "refs/tags/cli@1.2.3", "refs/tags/config@0.4.1"]);
  await commit(history, "feat(cli): add a command", "apps/cli/new-command.ts");
  await commit(history, "fix(api): correct config parsing", "packages/config/src/parser.ts");
  await pushCurrentBranch(history);

  const cli = await runRelease(history, { train: "cli", tagFormat: "cli@${version}" });
  const config = await runRelease(history, { train: "config", tagFormat: "config@${version}" });

  expectRelease(cli, "1.3.0-beta.1", "cli@1.3.0-beta.1");
  expectRelease(config, "0.4.2-beta.1", "config@0.4.2-beta.1");
});

test("config ownership follows paths when conventional scope disagrees", async () => {
  const history = await createHistory("config-v1.2.3");
  await git(history.repo, ["tag", "config@1.2.3", history.baselineSha]);
  await git(history.repo, ["push", "origin", "refs/tags/config@1.2.3"]);
  await commit(history, "feat(config): title claims config ownership", "apps/cli/not-config.ts");
  await commit(history, "fix(cli): actual diff owns config", "packages/config/src/owned.ts");
  await pushCurrentBranch(history);

  const result = await runRelease(history, { train: "config", tagFormat: "config@${version}" });

  expectRelease(result, "1.2.4-beta.1", "config@1.2.4-beta.1");
});

describe.each(HISTORICAL_INTERVALS)("historical interval: $name", (fixture) => {
  test("replays complete history and records current and hybrid results", async () => {
    const train = TRAINS.find(({ train }) => train === fixture.train);
    if (!train) {
      throw new Error(`unknown train ${fixture.train}`);
    }
    const history = await createHistory(`${train.legacyPrefix}${fixture.version}`);
    const sourceShaByGeneratedSha = new Map<string, string>();
    for (const historicalCommit of fixture.commits) {
      const generatedSha = await commit(history, historicalCommit.message, historicalCommit.path);
      sourceShaByGeneratedSha.set(generatedSha, historicalCommit.sourceSha);
    }
    await pushCurrentBranch(history);

    const current = await runRelease(history, {
      train: fixture.train,
      tagFormat: `${train.legacyPrefix}\${version}`,
      branches: fixture.train === "config" ? ["develop"] : undefined,
      plugin: fixture.train === "config" ? CURRENT_CONFIG_PLUGIN : CHARACTERIZATION_PLUGIN,
    });
    expectRelease(
      current,
      fixture.currentVersion,
      `${train.legacyPrefix}${fixture.currentVersion}`,
    );
    expect(current.commits.map(({ hash }) => sourceShaByGeneratedSha.get(hash))).toEqual(
      fixture.commits.map(({ sourceSha }) => sourceSha).reverse(),
    );

    const selectedCommits =
      fixture.train === "config"
        ? await filterCommitsToPackage(current.commits, history.repo)
        : current.commits;
    expect(selectedCommits.map(({ hash }) => sourceShaByGeneratedSha.get(hash))).toEqual(
      fixture.commits
        .filter(({ selected }) => selected)
        .map(({ sourceSha }) => sourceSha)
        .reverse(),
    );

    const hybrid = await withCompatibilityTags(
      history,
      [{ name: `${train.namespace}${fixture.version}`, target: history.baselineSha }],
      () =>
        runRelease(history, {
          train: fixture.train,
          tagFormat: `${train.namespace}\${version}`,
        }),
    );
    expectRelease(hybrid, fixture.hybridVersion, `${train.namespace}${fixture.hybridVersion}`);
  });
});

test("the config difference from stock analysis is limited to title-only classification", async () => {
  const history = await createHistory("config-v1.2.3");
  await commit(
    history,
    "docs: update migration guidance\n\nBREAKING CHANGE: body-only markers are ignored by the hybrid policy",
    "packages/config/docs/migration.md",
  );
  await pushCurrentBranch(history);

  const current = await runRelease(history, {
    train: "config",
    tagFormat: "config-v${version}",
    branches: ["develop"],
    plugin: CURRENT_CONFIG_PLUGIN,
  });
  expectRelease(current, "2.0.0", "config-v2.0.0");

  const hybrid = await withCompatibilityTags(
    history,
    [{ name: "config@1.2.3", target: history.baselineSha }],
    () => runRelease(history, { train: "config", tagFormat: "config@${version}" }),
  );
  expect(hybrid).toBe(false);
});
