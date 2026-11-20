import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateGate } from "./contribution-gate.ts";

test("sweeps reuse the same explanation after close fails but post a new one when the reason changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "contribution-gate-"));
  const statePath = join(root, "state.json");
  const preloadPath = join(root, "github.ts");
  const message = evaluateGate({
    repository: "supabase/cli",
    isInternal: false,
    isBot: false,
    linkedIssues: [],
  }).message;
  const bot = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
  const comments = Array.from({ length: 100 }, (_, index) => ({
    body: index === 3 ? "unrelated bot comment" : message,
    user:
      index === 0
        ? { ...bot, id: 123 }
        : index === 1
          ? { ...bot, login: "attacker" }
          : index === 2
            ? { ...bot, type: "User" }
            : index === 3
              ? bot
              : { id: 123, login: "attacker", type: "User" },
  }));
  try {
    await writeFile(
      statePath,
      JSON.stringify({ comments, posts: 0, closes: 0, pages: [], hasLinkedIssue: false }),
    );
    // Every request is intercepted in the child, including mutations and unknown URLs.
    await writeFile(
      preloadPath,
      `
      import { readFileSync, writeFileSync } from "node:fs";
      const path = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(path, "utf8"));
      const base = "https://api.github.com/repos/supabase/cli";
      const respond = (body, status = 200) => new Response(JSON.stringify(body), { status });
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        const method = init.method ?? "GET";
        if (url === base + "/pulls?state=open&per_page=100&page=1" && method === "GET") {
          return respond([{ number: 1, author_association: "NONE", user: { login: "ext", type: "User" } }]);
        }
        if (url === base + "/collaborators/ext/permission" && method === "GET") {
          return respond({ permission: "read" });
        }
        if (url === "https://api.github.com/graphql" && method === "POST") {
          const nodes = state.hasLinkedIssue ? [{ number: 5, state: "OPEN", repository: { nameWithOwner: "supabase/cli" }, labels: { nodes: [] } }] : [];
          return respond({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes } } } } });
        }
        if (url.startsWith(base + "/issues/1/comments?") && method === "GET") {
          const params = new URL(url).searchParams;
          if (params.get("per_page") !== "100") throw new Error("Expected paginated comments");
          const page = Number(params.get("page"));
          state.pages.push(page);
          return respond(state.comments.slice((page - 1) * 100, page * 100));
        }
        if (url === base + "/issues/1/comments" && method === "POST") {
          state.posts++;
          state.comments.push({ body: JSON.parse(init.body).body, user: ${JSON.stringify(bot)} });
          return respond({});
        }
        if (url === base + "/issues/1" && method === "PATCH") {
          state.closes++;
          return respond({}, state.closes === 1 ? 503 : 200);
        }
        throw new Error("Unexpected mocked GitHub request: " + method + " " + url);
      };
      process.on("exit", () => writeFileSync(path, JSON.stringify(state)));
    `,
    );
    const sweep = async () => {
      const child = Bun.spawn(
        [process.execPath, "--preload", preloadPath, join(import.meta.dir, "contribution-gate.ts")],
        {
          env: {
            ...process.env,
            GITHUB_TOKEN: "fake-test-token",
            GITHUB_REPOSITORY: "supabase/cli",
            DRY_RUN: "false",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    const first = await sweep();
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("503");
    const afterFirst = JSON.parse(await readFile(statePath, "utf8"));
    expect(afterFirst.posts).toBe(1);
    expect(afterFirst.closes).toBe(1);

    const second = await sweep();
    expect(second).toMatchObject({ code: 0, stderr: "" });
    expect(second.stdout).toContain("1 closed");
    expect(second.stdout).toContain("reason=no-linked-issue");
    const afterSecond = JSON.parse(await readFile(statePath, "utf8"));
    expect(afterSecond.posts).toBe(1);
    expect(afterSecond.closes).toBe(2);
    expect(afterSecond.pages).toEqual([1, 2, 1, 2]);

    await writeFile(statePath, JSON.stringify({ ...afterSecond, hasLinkedIssue: true }));
    const third = await sweep();
    expect(third).toMatchObject({ code: 0, stderr: "" });
    expect(third.stdout).toContain("reason=missing-label");
    const afterThird = JSON.parse(await readFile(statePath, "utf8"));
    expect(afterThird.posts).toBe(2);
    expect(afterThird.closes).toBe(3);
    expect(afterThird.comments.at(-1).body).toContain(
      "The linked issue hasn't been marked `open-for-contribution` yet",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
