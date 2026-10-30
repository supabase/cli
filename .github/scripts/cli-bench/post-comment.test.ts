import { describe, expect, test } from "bun:test";
import {
  commentFailed,
  composeBody,
  failureMarkdown,
  findComment,
  MARKERS,
  MAX_BODY_CHARS,
  RERUN_NOTES,
  sanitize,
  writeComment,
  type CommentIo,
  type ExistingComment,
  type Kind,
} from "./post-comment.ts";
import { decodeHistory, MAX_PREVIOUS_RUNS, type RunEntry } from "./history.ts";

const BOT = "github-actions[bot]";
const RUN = "https://github.com/o/r/actions/runs/";
const NOW = new Date("2026-10-28T09:05:00Z");
const SHA = "0123456789abcdef";

const titleOf = (kind: Kind) =>
  kind === "lightweight" ? "## CLI benchmark" : "## CLI benchmark (Integration Heavy Commands)";
const report = (kind: Kind, title: string) => `${titleOf(kind)}: ${title}\n\ndetails`;

/** An in-memory comment thread. */
function fakeThread(initial: Array<ExistingComment> = []) {
  const comments = [...initial];
  let nextId = 100;
  const io: CommentIo = {
    list: async () => comments.map((comment) => ({ ...comment })),
    create: async (body) => {
      comments.push({ id: nextId, body, authorLogin: BOT });
      return nextId++;
    },
    update: async (id, body) => {
      const target = comments.find((comment) => comment.id === id);
      if (target !== undefined) target.body = body;
    },
  };
  return { comments, io };
}

const bodyOf = (comments: Array<ExistingComment>, kind: Kind) =>
  findComment(kind, comments)?.body ?? "";

const entry = (n: number): RunEntry => ({
  sha: n.toString(16).padStart(7, "0"),
  at: "2026-10-28T09:05Z",
  headline: "no changes found",
  url: `${RUN}${n}`,
});

describe("findComment", () => {
  test("keeps the lightweight marker the first benchmark comments already carry", () => {
    expect(MARKERS.lightweight).toBe("<!-- cli-bench:pr -->");
    expect(MARKERS["integration-heavy"]).not.toBe(MARKERS.lightweight);
  });

  test("finds each comment by its own marker", () => {
    const light = { id: 1, body: `${MARKERS.lightweight}\nx`, authorLogin: BOT };
    const full = { id: 2, body: `${MARKERS["integration-heavy"]}\nx`, authorLogin: BOT };

    expect(findComment("lightweight", [full, light])?.id).toBe(1);
    expect(findComment("integration-heavy", [light, full])?.id).toBe(2);
  });

  test("ignores a marker pasted by someone else", () => {
    const forged = { id: 6, body: MARKERS.lightweight, authorLogin: "mallory" };

    expect(findComment("lightweight", [forged])).toBeUndefined();
  });

  test("keeps the older comment when two exist", () => {
    const older = { id: 3, body: MARKERS.lightweight, authorLogin: BOT };
    const newer = { id: 9, body: MARKERS.lightweight, authorLogin: BOT };

    expect(findComment("lightweight", [newer, older])?.id).toBe(3);
  });
});

describe("composeBody", () => {
  test("lightweight comment starts with its marker once and ends its text with its own note", () => {
    const body = composeBody("lightweight", report("lightweight", "new"));

    expect(body.startsWith(`${MARKERS.lightweight}\n`)).toBe(true);
    expect(body.split(MARKERS.lightweight).length - 1).toBe(1);
    expect(body).toContain(`\n\n${RERUN_NOTES.lightweight}\n`);
    expect(RERUN_NOTES.lightweight).toBe(
      "Comment `/bench` to run the lightweight benchmark (this comment) again on the latest commit, or `/bench full` to also run the integration-heavy benchmark, which posts in its own comment.",
    );
    expect(body).not.toContain(RERUN_NOTES["integration-heavy"]);
  });

  test("integration-heavy comment starts with its marker once and ends its text with its own note", () => {
    const body = composeBody("integration-heavy", report("integration-heavy", "new"));

    expect(body.startsWith(`${MARKERS["integration-heavy"]}\n`)).toBe(true);
    expect(body.split(MARKERS["integration-heavy"]).length - 1).toBe(1);
    expect(body).toContain(`\n\n${RERUN_NOTES["integration-heavy"]}\n`);
    expect(RERUN_NOTES["integration-heavy"]).toBe(
      "Comment `/bench full` to run this benchmark again on the latest commit, which also refreshes the lightweight comment if it is behind. `/bench` runs only the lightweight benchmark.",
    );
    expect(body).not.toContain(RERUN_NOTES.lightweight);
  });

  test("cuts an oversized report below GitHub's limit and says so", () => {
    const body = composeBody("lightweight", "x".repeat(MAX_BODY_CHARS * 2), [entry(1)]);

    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(body).toContain("The report was truncated");
    expect(body.startsWith(MARKERS.lightweight)).toBe(true);
    expect(decodeHistory(body)).toEqual([entry(1)]);
  });

  test("drops the oldest runs before cutting the report when the body is too long", () => {
    const entries = Array.from({ length: 21 }, (_, i) => ({
      ...entry(i + 1),
      headline: "h".repeat(100),
    }));
    const content = "x".repeat(MAX_BODY_CHARS - 2_500);

    const body = composeBody("lightweight", content, entries);

    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(body).toContain(content);
    const kept = decodeHistory(body);
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept.length).toBeLessThan(entries.length);
    expect(kept).toEqual(entries.slice(0, kept.length));
  });

  test("keeps the newest run when the report alone fills the body", () => {
    const entries = [entry(3), entry(2), entry(1)];

    const body = composeBody("integration-heavy", "x".repeat(MAX_BODY_CHARS), entries);

    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(decodeHistory(body)).toEqual([entry(3)]);
  });

  test("renders a previous run's headline through the sanitizer", () => {
    const hostile = { ...entry(1), headline: "@team [x](https://evil.test)" };

    const body = composeBody("lightweight", "report", [entry(2), hostile]);

    expect(body).not.toContain("](https://evil.test)");
    expect(body).not.toMatch(/@(?!​)/u);
  });
});

describe("sanitize", () => {
  test("neutralizes mentions, links, images and unknown HTML but keeps the report tags", () => {
    const hostile =
      "@org/team [x](https://evil.test) ![i](https://evil.test/a.png) <img src=x> &#64;u [a][r] www.evil.test <details>";

    const clean = sanitize(hostile);

    expect(clean).not.toMatch(/@(?!​)/u);
    expect(clean).not.toContain("&#64;");
    expect(clean).not.toMatch(/(?<!\\)\[/u);
    expect(clean).not.toContain("www.");
    expect(clean).not.toContain("://");
    expect(clean).not.toContain("<img");
    expect(clean).toContain("<details>");
  });

  test("keeps an escaped bracket from becoming a live link", () => {
    const clean = sanitize("\\[x\\](//evil.example/p)");

    expect(clean).toBe("\\\\\\[x\\\\\\](//evil.example/p)");
  });

  test("keeps the escaped pipes of a table cell intact", () => {
    expect(sanitize("| `supabase db query a\\|b` | 1 ms |")).toBe(
      "| `supabase db query a\\|b` | 1 ms |",
    );
  });

  test("keeps a report from forging a marker", () => {
    expect(sanitize(`${MARKERS.lightweight} <!-- cli-bench:history abc -->`)).not.toContain("<!--");
  });
});

describe("writeComment", () => {
  const input = (overrides: Partial<Parameters<typeof writeComment>[1]> = {}) => ({
    mode: "upsert" as const,
    kind: "lightweight" as const,
    sha: SHA,
    markdown: report("lightweight", "no changes found"),
    runUrl: `${RUN}1`,
    now: NOW,
    ...overrides,
  });

  test("creates the comment with the report, its run link and a first history entry", async () => {
    const thread = fakeThread();

    const result = await writeComment(thread.io, input());

    expect(result).toMatchObject({ kind: "written", created: true });
    const body = bodyOf(thread.comments, "lightweight");
    expect(body).toContain("no changes found");
    expect(body).toContain(`[Workflow run](${RUN}1)`);
    expect(decodeHistory(body)).toMatchObject([{ sha: "0123456", url: `${RUN}1` }]);
  });

  test("writing the integration-heavy comment leaves the lightweight comment byte-identical", async () => {
    const thread = fakeThread();
    await writeComment(thread.io, input());
    const before = bodyOf(thread.comments, "lightweight");

    await writeComment(
      thread.io,
      input({
        kind: "integration-heavy",
        markdown: report("integration-heavy", "2 things to check"),
        runUrl: `${RUN}2`,
      }),
    );
    await writeComment(
      thread.io,
      input({ kind: "integration-heavy", mode: "running", runUrl: `${RUN}3` }),
    );

    expect(thread.comments).toHaveLength(2);
    expect(bodyOf(thread.comments, "lightweight")).toBe(before);
  });

  test("writing the lightweight comment leaves the integration-heavy comment byte-identical", async () => {
    const thread = fakeThread();
    await writeComment(
      thread.io,
      input({ kind: "integration-heavy", markdown: report("integration-heavy", "ok") }),
    );
    const before = bodyOf(thread.comments, "integration-heavy");

    await writeComment(thread.io, input({ runUrl: `${RUN}2` }));
    await writeComment(thread.io, input({ runUrl: `${RUN}3` }));

    expect(bodyOf(thread.comments, "integration-heavy")).toBe(before);
  });

  test("keeps a separate history of previous runs per comment", async () => {
    const thread = fakeThread();
    await writeComment(thread.io, input({ runUrl: `${RUN}1` }));
    await writeComment(
      thread.io,
      input({
        kind: "integration-heavy",
        markdown: report("integration-heavy", "1 thing to check"),
        runUrl: `${RUN}2`,
      }),
    );

    await writeComment(
      thread.io,
      input({ markdown: report("lightweight", "3 things to check"), runUrl: `${RUN}4` }),
    );

    const light = bodyOf(thread.comments, "lightweight");
    expect(decodeHistory(light).map((run) => run.url)).toEqual([`${RUN}4`, `${RUN}1`]);
    expect(light).toContain("<summary>Previous runs</summary>");
    expect(light).toContain(`[run](${RUN}1)`);
    expect(light).not.toContain(`${RUN}2`);
    const full = bodyOf(thread.comments, "integration-heavy");
    expect(decodeHistory(full).map((run) => run.url)).toEqual([`${RUN}2`]);
    expect(full).not.toContain("Previous runs");
  });

  test("keeps the newest 20 previous runs", async () => {
    const thread = fakeThread();
    for (let n = 1; n <= MAX_PREVIOUS_RUNS + 5; n++) {
      await writeComment(thread.io, input({ runUrl: `${RUN}${n}` }));
    }

    const history = decodeHistory(bodyOf(thread.comments, "lightweight"));

    expect(history).toHaveLength(MAX_PREVIOUS_RUNS + 1);
    expect(history[0]?.url).toBe(`${RUN}${MAX_PREVIOUS_RUNS + 5}`);
  });

  test("shows a running placeholder with the commit and run link and lists the old result as previous", async () => {
    const thread = fakeThread();
    await writeComment(
      thread.io,
      input({
        kind: "integration-heavy",
        markdown: report("integration-heavy", "no changes found"),
        runUrl: `${RUN}1`,
      }),
    );

    await writeComment(
      thread.io,
      input({
        kind: "integration-heavy",
        mode: "running",
        markdown: undefined,
        sha: "fedcba9876543210",
        runUrl: `${RUN}2/attempts/1`,
      }),
    );

    const body = bodyOf(thread.comments, "integration-heavy");
    expect(body).toContain("## CLI benchmark (Integration Heavy Commands): running");
    expect(body).toContain("Started 2026-10-28 09:05 UTC for commit `fedcba9`.");
    expect(body).toContain(`[Workflow run](${RUN}2/attempts/1)`);
    expect(body).toContain("<summary>Previous runs</summary>");
    expect(body).toContain(`[run](${RUN}1)`);
    expect(decodeHistory(body)).toHaveLength(1);
  });

  test("creates the comment when a run starts before any result exists", async () => {
    const thread = fakeThread();

    const result = await writeComment(
      thread.io,
      input({ kind: "integration-heavy", mode: "running", markdown: undefined }),
    );

    expect(result).toMatchObject({ kind: "written", created: true });
    expect(bodyOf(thread.comments, "integration-heavy")).toContain(": running");
  });

  test("records a run that produced no report as a failed result", async () => {
    const thread = fakeThread();

    await writeComment(thread.io, input({ markdown: failureMarkdown("lightweight", SHA) }));

    const body = bodyOf(thread.comments, "lightweight");
    expect(commentFailed(body)).toBe(true);
    expect(body).toContain("for commit `0123456`");
  });

  test("keeps a report's own markers out of the comment", async () => {
    const thread = fakeThread();

    await writeComment(
      thread.io,
      input({
        markdown: `${MARKERS.lightweight}\n${MARKERS["integration-heavy"]}\n${report("lightweight", "ok")}`,
      }),
    );

    const body = bodyOf(thread.comments, "lightweight");
    expect(body.split(MARKERS.lightweight).length - 1).toBe(1);
    expect(body).not.toContain(MARKERS["integration-heavy"]);
  });

  test("leaves a comment that reports a result alone in create-if-missing mode", async () => {
    const thread = fakeThread();
    await writeComment(thread.io, input());
    const before = bodyOf(thread.comments, "lightweight");

    const result = await writeComment(
      thread.io,
      input({ mode: "create-if-missing", runUrl: `${RUN}2` }),
    );

    expect(result).toEqual({ kind: "skipped" });
    expect(bodyOf(thread.comments, "lightweight")).toBe(before);
  });

  test("replaces a first-run failure notice in create-if-missing mode", async () => {
    const thread = fakeThread();
    await writeComment(thread.io, input({ markdown: failureMarkdown("lightweight", SHA) }));

    const result = await writeComment(
      thread.io,
      input({ mode: "create-if-missing", runUrl: `${RUN}2` }),
    );

    expect(result).toMatchObject({ kind: "written", created: false });
    expect(commentFailed(bodyOf(thread.comments, "lightweight"))).toBe(false);
  });

  test("creates the comment in create-if-missing mode when only the other comment exists", async () => {
    const thread = fakeThread();
    await writeComment(
      thread.io,
      input({ kind: "integration-heavy", markdown: report("integration-heavy", "ok") }),
    );

    const result = await writeComment(thread.io, input({ mode: "create-if-missing" }));

    expect(result).toMatchObject({ kind: "written", created: true });
    expect(thread.comments).toHaveLength(2);
  });
});
