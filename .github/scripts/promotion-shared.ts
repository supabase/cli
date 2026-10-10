import { spawnSync } from "node:child_process";

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[]) => GitResult;

export function makeGit(cwd: string): GitRunner {
  return (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.error) {
      throw result.error;
    }
    return {
      status: result.status ?? 1,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  };
}

export function gitOrThrow(git: GitRunner, args: string[]): string {
  const result = git(args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export const MAX_PUSH_ATTEMPTS = 3;

/** Pushes HEAD to the target; `retry` means the push lost a race with a newer target tip, so merge again. */
export function pushMergedTarget(
  git: GitRunner,
  target: string,
  mergedTargetSha: string,
): "pushed" | "retry" {
  const push = git(["push", "origin", `HEAD:refs/heads/${target}`]);
  if (push.status === 0) {
    return "pushed";
  }
  const latestTarget = git(["ls-remote", "--heads", "origin", `refs/heads/${target}`]);
  if (latestTarget.status !== 0 || latestTarget.stdout.startsWith(mergedTargetSha)) {
    throw new Error(`git push to ${target} failed: ${push.stderr}`);
  }
  return "retry";
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/** GET without a body, POST (or `method`) with one. */
export async function githubRequest<T>(
  token: string,
  path: string,
  body?: unknown,
  method: "POST" | "PATCH" = "POST",
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const url = `https://api.github.com${path}`;
  const response =
    body === undefined
      ? await fetch(url, { method: "GET", headers })
      : await fetch(url, {
          method,
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** The only branch pairs that sync; each is promoted by a `sync/<source>-into-<target>` pull request. */
export const SYNC_PAIRS = [
  { source: "main", target: "develop" },
  { source: "develop", target: "next" },
] as const;

/** Login of the release GitHub App, the only author of sync pull requests. */
export const RELEASE_BOT_LOGIN = "supabase-cli-releaser[bot]";

export function isAllowedSyncPair(source: string, target: string): boolean {
  return SYNC_PAIRS.some((pair) => pair.source === source && pair.target === target);
}

/** GraphQL. Errors in the response body are thrown. */
export async function githubGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await githubRequest<{ data?: T; errors?: { message: string }[] }>(
    token,
    "/graphql",
    { query, variables },
  );
  if (response.errors?.length || response.data === undefined) {
    throw new Error(
      `GraphQL query failed: ${response.errors?.map((error) => error.message).join("; ") ?? "no data"}`,
    );
  }
  return response.data;
}
