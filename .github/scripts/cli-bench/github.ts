/** Small GitHub REST helpers shared by the CLI benchmark scripts. */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/** A GitHub request that did not succeed, with the HTTP status and GitHub's own message. */
export class GithubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    url: string,
  ) {
    super(`GitHub request failed (${status}) for ${url}`);
    this.name = "GithubRequestError";
  }
}

export async function githubFetch(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { message?: unknown };
    const detail = typeof payload.message === "string" ? payload.message : response.statusText;
    throw new GithubRequestError(response.status, detail, url);
  }
  return response;
}

export interface IssueComment {
  id: number;
  body: string;
  authorLogin: string;
}

/** Every comment on an issue or pull request, oldest first. */
export async function listIssueComments(
  token: string,
  base: string,
  issue: number,
): Promise<Array<IssueComment>> {
  const comments: Array<IssueComment> = [];
  for (let page = 1; ; page++) {
    const batch = (await (
      await githubFetch(`${base}/issues/${issue}/comments?per_page=100&page=${page}`, token)
    ).json()) as Array<{ id: number; body: string | null; user: { login: string } | null }>;
    comments.push(
      ...batch.map((entry) => ({
        id: entry.id,
        body: entry.body ?? "",
        authorLogin: entry.user?.login ?? "",
      })),
    );
    if (batch.length < 100) return comments;
  }
}

/** One comment by id, or undefined when it no longer exists. */
export async function getIssueComment(
  token: string,
  base: string,
  id: number,
): Promise<IssueComment | undefined> {
  try {
    const entry = (await (await githubFetch(`${base}/issues/comments/${id}`, token)).json()) as {
      id: number;
      body: string | null;
      user: { login: string } | null;
    };
    return { id: entry.id, body: entry.body ?? "", authorLogin: entry.user?.login ?? "" };
  } catch (error) {
    if (error instanceof GithubRequestError && error.status === 404) return undefined;
    throw error;
  }
}
