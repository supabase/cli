import { describe, expect, test } from "bun:test";
import {
  BENCH_MARKER,
  composeBody,
  failureMarkdown,
  findBenchComment,
  MAX_BODY_CHARS,
  MAX_WRITE_ATTEMPTS,
  parseSections,
  planComment,
  RERUN_NOTE,
  sanitize,
  writeSection,
  type CommentIo,
  type ExistingComment,
} from "./post-comment.ts";
import { decodeHistory, type RunEntry } from "./history.ts";

const BOT = "github-actions[bot]";
const RUN = "https://github.com/o/r/actions/runs/";
const NOW = new Date("2026-10-28T09:05:00Z");
const SHA = "0123456789abcdef";

const withSections = (id: number, body: string): ExistingComment => ({
  id,
  body,
  authorLogin: BOT,
});

/** An in-memory comment thread with hooks to interleave other writers' updates. */
function fakeThread(initial: Array<ExistingComment> = []) {
  const comments = [...initial];
  let nextId = 100;
  const hooks: { afterUpdate?: () => void; afterCreate?: () => void; afterList?: () => void } = {};
  const io: CommentIo = {
    list: async () => {
      const snapshot = comments.map((comment) => ({ ...comment }));
      hooks.afterList?.();
      return snapshot;
    },
    get: async (id) => comments.find((comment) => comment.id === id),
    create: async (body) => {
      const created = withSections(nextId++, body);
      comments.push(created);
      hooks.afterCreate?.();
      return created.id;
    },
    update: async (id, body) => {
      const target = comments.find((comment) => comment.id === id);
      if (target !== undefined) target.body = body;
      hooks.afterUpdate?.();
    },
    remove: async (id) => {
      comments.splice(
        comments.findIndex((comment) => comment.id === id),
        1,
      );
    },
  };
  return { comments, io, hooks };
}

const report = (title: string, section: "Lightweight" | "Integration Heavy") =>
  `### ${section} Commands: ${title}\n\ndetails`;

describe("planComment", () => {
  test("creates the comment when none carries the marker", () => {
    expect(
      planComment("create-if-missing", "lightweight", [{ id: 1, body: "hi", authorLogin: BOT }]),
    ).toEqual({ kind: "create" });
  });

  test("leaves a section that already reports a result alone on a later push", () => {
    const existing = withSections(
      5,
      composeBody({ lightweight: { sha: "abc1234", content: report("old", "Lightweight") } }),
    );

    expect(planComment("create-if-missing", "lightweight", [existing])).toEqual({ kind: "skip" });
  });

  test("fills a section the comment does not have yet, even on a later push", () => {
    const existing = withSections(
      5,
      composeBody({
        "integration-heavy": { sha: "abc1234", content: report("old", "Integration Heavy") },
      }),
    );

    expect(planComment("create-if-missing", "lightweight", [existing])).toEqual({
      kind: "update",
      id: 5,
      previousBody: existing.body,
    });
  });

  test("replaces a first-run failure notice on a later push", () => {
    const failed = withSections(
      5,
      composeBody({ lightweight: { sha: "abc1234", content: failureMarkdown("lightweight") } }),
    );

    expect(planComment("create-if-missing", "lightweight", [failed]).kind).toBe("update");
  });

  test.each(["upsert", "running"] as const)("updates a reported section for %s", (mode) => {
    const existing = withSections(
      5,
      composeBody({ lightweight: { sha: "abc1234", content: report("old", "Lightweight") } }),
    );

    expect(planComment(mode, "lightweight", [existing]).kind).toBe("update");
  });

  test("ignores a marker pasted by someone else", () => {
    const forged = { id: 6, body: BENCH_MARKER, authorLogin: "mallory" };

    expect(planComment("create-if-missing", "lightweight", [forged])).toEqual({ kind: "create" });
  });

  test("keeps the older comment when two writers each created one", () => {
    const older = withSections(3, BENCH_MARKER);
    const newer = withSections(9, BENCH_MARKER);

    expect(findBenchComment([newer, older])?.id).toBe(3);
  });
});

describe("composeBody", () => {
  test("puts the marker first and ends with the rerun note for both commands", () => {
    const body = composeBody({
      lightweight: { sha: "abc1234", content: report("new", "Lightweight") },
    });

    expect(body.startsWith(`${BENCH_MARKER}\n`)).toBe(true);
    expect(body.split(BENCH_MARKER).length - 1).toBe(1);
    expect(body).toContain(RERUN_NOTE);
    expect(RERUN_NOTE).toBe(
      "Comment `/bench` (only includes lightweight benchmarks) or `/bench full` to run it again on the latest commit.",
    );
    expect(body).not.toContain("Comment `/bench` to run it again");
  });

  test("keeps each section's commit and content readable from the body", () => {
    const body = composeBody({
      lightweight: { sha: "abc1234", content: report("a", "Lightweight") },
      "integration-heavy": { sha: "def5678", content: report("b", "Integration Heavy") },
    });

    expect(parseSections(body)).toEqual({
      lightweight: { sha: "abc1234", content: report("a", "Lightweight") },
      "integration-heavy": { sha: "def5678", content: report("b", "Integration Heavy") },
    });
  });

  test("cuts oversized sections below GitHub's limit and says so", () => {
    const body = composeBody({
      lightweight: { sha: "abc1234", content: "x".repeat(200_000) },
      "integration-heavy": { sha: "abc1234", content: "y".repeat(200_000) },
    });

    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(body).toContain("truncated");
    expect(parseSections(body).lightweight).toBeDefined();
    expect(parseSections(body)["integration-heavy"]).toBeDefined();
  });

  const run = (n: number): RunEntry => ({
    section: "lightweight",
    sha: n.toString(16).padStart(7, "0"),
    at: "2026-10-28T09:05Z",
    headline: "no changes found",
    url: `${RUN}${n}`,
  });

  test("drops the oldest runs before cutting a section when the body is too long", () => {
    const history = Array.from({ length: 21 }, (_, i) => run(21 - i));
    const content = "x".repeat(MAX_BODY_CHARS - 4_000);

    const body = composeBody({ lightweight: { sha: "abc1234", content } }, history);

    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(body).not.toContain("truncated");
    const kept = decodeHistory(body);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(history.length);
    expect(kept[0]).toEqual(history[0]);
  });

  test("keeps each section's newest run when the sections alone fill the body", () => {
    const heavy = { ...run(9), section: "integration-heavy" as const };
    const body = composeBody(
      {
        lightweight: { sha: "abc1234", content: "x".repeat(200_000) },
        "integration-heavy": { sha: "abc1234", content: "y".repeat(200_000) },
      },
      [run(8), heavy, run(7)],
    );

    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(decodeHistory(body)).toEqual([run(8), heavy]);
  });

  test("lets a larger section use the space a smaller one leaves", () => {
    const small = "s".repeat(1_000);
    const body = composeBody({
      lightweight: { sha: "abc1234", content: small },
      "integration-heavy": { sha: "abc1234", content: "y".repeat(200_000) },
    });

    const sections = parseSections(body);
    expect(sections.lightweight?.content).toBe(small);
    expect(sections["integration-heavy"]?.content.length).toBeGreaterThan(MAX_BODY_CHARS / 2);
  });

  test("renders a previous run's headline through the sanitizer", () => {
    const hostile = { ...run(1), headline: "@team <img src=x>" };

    const body = composeBody(
      { lightweight: { sha: "abc1234", content: report("new", "Lightweight") } },
      [run(3), run(2), hostile],
    );

    expect(body).not.toContain("<img");
    expect(body).not.toMatch(/@(?!\u200b)/u);
  });
});

describe("sanitize", () => {
  test("neutralizes mentions, links, images and unknown HTML but keeps the report tags", () => {
    const hostile =
      "@org/team [x](https://evil.test) ![i](https://evil.test/a.png) <img src=x> &#64;u [a][r] www.evil.test <details>";

    const clean = sanitize(hostile);

    expect(clean).not.toMatch(/@(?!\u200b)/u);
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

  test("keeps a report from forging a section marker", () => {
    const forged = sanitize("<!-- cli-bench:section-end lightweight -->");

    expect(forged).not.toContain("<!--");
  });
});

describe("writeSection", () => {
  const input = (overrides: Partial<Parameters<typeof writeSection>[1]> = {}) => ({
    mode: "upsert" as const,
    section: "lightweight" as const,
    sha: SHA,
    markdown: report("no changes found", "Lightweight"),
    runUrl: `${RUN}1`,
    now: NOW,
    ...overrides,
  });

  test("creates the comment with the section, its run link and the commit it measured", async () => {
    const thread = fakeThread();

    const result = await writeSection(thread.io, input());

    expect(result).toMatchObject({ kind: "written", created: true });
    const section = parseSections(thread.comments[0]!.body).lightweight;
    expect(section?.sha).toBe("0123456");
    expect(section?.content).toContain("no changes found");
    expect(section?.content).toContain(`[Workflow run](${RUN}1)`);
  });

  test("replaces only its own section and moves the replaced result into previous runs", async () => {
    const thread = fakeThread();
    await writeSection(thread.io, input({ runUrl: `${RUN}1` }));
    await writeSection(
      thread.io,
      input({
        section: "integration-heavy",
        markdown: report("no changes found", "Integration Heavy"),
        runUrl: `${RUN}2`,
      }),
    );

    await writeSection(
      thread.io,
      input({ markdown: report("1 thing to check", "Lightweight"), runUrl: `${RUN}3` }),
    );

    const body = thread.comments[0]!.body;
    const sections = parseSections(body);
    expect(sections.lightweight?.content).toContain("1 thing to check");
    expect(sections["integration-heavy"]?.content).toContain("no changes found");
    expect(body).toContain("Previous runs");
    expect(body).toContain(
      `Lightweight Commands · \`0123456\` · 2026-10-28 09:05 UTC · no changes found · [run](${RUN}1)`,
    );
    expect(body).not.toContain(`[run](${RUN}2)`);
  });

  test("shows a running placeholder with the run link and keeps the old result as a previous run", async () => {
    const thread = fakeThread();
    await writeSection(
      thread.io,
      input({
        section: "integration-heavy",
        markdown: report("2 things to check", "Integration Heavy"),
        runUrl: `${RUN}1`,
      }),
    );

    await writeSection(
      thread.io,
      input({
        section: "integration-heavy",
        mode: "running",
        markdown: undefined,
        runUrl: `${RUN}2`,
      }),
    );

    const body = thread.comments[0]!.body;
    const section = parseSections(body)["integration-heavy"];
    expect(section?.content).toContain("Integration Heavy Commands: running");
    expect(section?.content).toContain(`[Workflow run](${RUN}2)`);
    expect(body).toContain(
      `Integration Heavy Commands · \`0123456\` · 2026-10-28 09:05 UTC · 2 things to check`,
    );
  });

  test("rebuilds from the comment when another writer changed it after the listing", async () => {
    const thread = fakeThread([
      withSections(
        7,
        composeBody({ lightweight: { sha: "abc1234", content: report("old", "Lightweight") } }),
      ),
    ]);
    let interleaved = false;
    thread.hooks.afterList = () => {
      if (interleaved) return;
      interleaved = true;
      thread.comments[0]!.body = composeBody({
        lightweight: { sha: "abc1234", content: report("old", "Lightweight") },
        "integration-heavy": { sha: "def5678", content: report("other", "Integration Heavy") },
      });
    };

    const result = await writeSection(thread.io, input({ markdown: report("new", "Lightweight") }));

    expect(result).toMatchObject({ kind: "written", attempts: 2 });
    const sections = parseSections(thread.comments[0]!.body);
    expect(sections.lightweight?.content).toContain("new");
    expect(sections["integration-heavy"]?.content).toContain("other");
  });

  test("keeps a report's own marker out of the comment", async () => {
    const thread = fakeThread();

    await writeSection(
      thread.io,
      input({ markdown: `${report("new", "Lightweight")} ${BENCH_MARKER}` }),
    );

    expect(thread.comments[0]!.body.split(BENCH_MARKER).length - 1).toBe(1);
  });

  test("retries when a concurrent writer overwrites its section, and ends with both sections", async () => {
    const thread = fakeThread([
      withSections(
        7,
        composeBody({ lightweight: { sha: "abc1234", content: report("old", "Lightweight") } }),
      ),
    ]);
    let interleaved = false;
    thread.hooks.afterUpdate = () => {
      if (interleaved) return;
      interleaved = true;
      // The other writer read the comment before this write and now writes its own section back.
      thread.comments[0]!.body = composeBody({
        lightweight: { sha: "abc1234", content: report("old", "Lightweight") },
        "integration-heavy": { sha: "def5678", content: report("other", "Integration Heavy") },
      });
    };

    const result = await writeSection(thread.io, input({ markdown: report("new", "Lightweight") }));

    expect(result).toMatchObject({ kind: "written", attempts: 2 });
    const sections = parseSections(thread.comments[0]!.body);
    expect(sections.lightweight?.content).toContain("new");
    expect(sections["integration-heavy"]?.content).toContain("other");
  });

  test("gives up as unverified after the attempt limit when its section keeps being overwritten", async () => {
    const thread = fakeThread([
      withSections(7, composeBody({ lightweight: { sha: "abc1234", content: "old" } })),
    ]);
    thread.hooks.afterUpdate = () => {
      thread.comments[0]!.body = composeBody({ lightweight: { sha: "abc1234", content: "old" } });
    };

    const result = await writeSection(thread.io, input());

    expect(result).toEqual({ kind: "unverified", attempts: MAX_WRITE_ATTEMPTS });
  });

  test("removes its own comment when another writer created the comment first", async () => {
    const thread = fakeThread();
    thread.hooks.afterCreate = () => {
      thread.hooks.afterCreate = undefined;
      thread.comments.unshift(
        withSections(
          3,
          composeBody({
            "integration-heavy": { sha: "def5678", content: report("other", "Integration Heavy") },
          }),
        ),
      );
    };

    const result = await writeSection(thread.io, input());

    expect(result).toMatchObject({ kind: "written", created: false });
    expect(thread.comments.map((comment) => comment.id)).toEqual([3]);
    const sections = parseSections(thread.comments[0]!.body);
    expect(sections.lightweight).toBeDefined();
    expect(sections["integration-heavy"]).toBeDefined();
  });

  test("leaves a reported section alone in create-if-missing mode", async () => {
    const thread = fakeThread();
    await writeSection(thread.io, input());
    const before = thread.comments[0]!.body;

    const result = await writeSection(
      thread.io,
      input({ mode: "create-if-missing", markdown: report("newer", "Lightweight") }),
    );

    expect(result).toEqual({ kind: "skipped" });
    expect(thread.comments[0]!.body).toBe(before);
  });
});
