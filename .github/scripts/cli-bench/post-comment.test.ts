import { describe, expect, test } from "bun:test";
import {
  BENCH_MARKER,
  FAILURE_TITLE,
  MAX_BODY_CHARS,
  planComment,
  prepareBody,
  sanitize,
} from "./post-comment.ts";

const BOT = "github-actions[bot]";

describe("planComment", () => {
  test("creates the comment when none carries the marker", () => {
    expect(planComment("create-if-missing", [{ id: 1, body: "hi", authorLogin: BOT }])).toEqual({
      kind: "create",
    });
  });

  test("leaves an existing marker comment alone on a later push", () => {
    const existing = { id: 5, body: `${BENCH_MARKER}\nold`, authorLogin: BOT };

    expect(planComment("create-if-missing", [existing])).toEqual({ kind: "skip" });
  });

  test("replaces a first-run failure notice on a later push", () => {
    const failed = {
      id: 5,
      body: `${BENCH_MARKER}\n${FAILURE_TITLE}\nbuild failed`,
      authorLogin: BOT,
    };

    expect(planComment("create-if-missing", [failed])).toEqual({ kind: "update", id: 5 });
  });

  test("updates the marker comment in place for /bench", () => {
    const existing = { id: 5, body: `${BENCH_MARKER}\nold`, authorLogin: BOT };

    expect(planComment("upsert", [existing])).toEqual({ kind: "update", id: 5 });
  });

  test("ignores a marker pasted by someone else", () => {
    const forged = { id: 6, body: BENCH_MARKER, authorLogin: "mallory" };

    expect(planComment("create-if-missing", [forged])).toEqual({ kind: "create" });
  });
});

describe("prepareBody", () => {
  test("puts the marker first exactly once", () => {
    const body = prepareBody(`text ${BENCH_MARKER} more`);

    expect(body.startsWith(`${BENCH_MARKER}\n`)).toBe(true);
    expect(body.split(BENCH_MARKER)).toHaveLength(2);
  });

  test("cuts an oversized report below GitHub's limit and says so", () => {
    const body = prepareBody("x".repeat(200_000));

    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(body).toContain("truncated");
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

  test("pins the failure title and marker literals the renderer emits", () => {
    expect(FAILURE_TITLE).toBe("## CLI benchmark: could not run");
    expect(BENCH_MARKER).toBe("<!-- cli-bench:pr -->");
  });
});

describe("prepareBody run link", () => {
  test("appends the trusted run link after the report", () => {
    const body = prepareBody("report", "https://github.com/o/r/actions/runs/1");

    expect(body.trimEnd().endsWith("[Workflow run](https://github.com/o/r/actions/runs/1)")).toBe(
      true,
    );
  });
});
