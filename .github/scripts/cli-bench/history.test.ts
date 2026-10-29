import { describe, expect, test } from "bun:test";
import {
  decodeHistory,
  headlineOf,
  makeEntry,
  MAX_PREVIOUS_RUNS,
  mergeHistory,
  renderHistory,
  type RunEntry,
} from "./history.ts";

const entry = (n: number, overrides: Partial<RunEntry> = {}): RunEntry => ({
  sha: n.toString(16).padStart(7, "0"),
  at: "2026-10-28T09:05Z",
  headline: "no changes found",
  url: `https://github.com/o/r/actions/runs/${n}`,
  ...overrides,
});

describe("headlineOf", () => {
  test("reads the title of the rendered report", () => {
    expect(headlineOf("<!-- cli-bench:pr -->\n\n## CLI benchmark: 2 things to check\n\nbody")).toBe(
      "2 things to check",
    );
  });

  test("falls back when the report has no title", () => {
    expect(headlineOf("nothing here")).toBe("unknown");
  });
});

describe("makeEntry", () => {
  test("shortens the commit and rounds the time down to the minute in UTC", () => {
    const made = makeEntry({
      sha: "0123456789abcdef0123456789abcdef01234567",
      now: new Date("2026-10-28T09:05:59Z"),
      headline: "no changes found",
      url: "https://github.com/o/r/actions/runs/9/attempts/2",
    });

    expect(made).toMatchObject({ sha: "0123456", at: "2026-10-28T09:05Z" });
  });

  test("refuses a run link that is not a workflow run", () => {
    const made = makeEntry({
      sha: "abcdef1",
      now: new Date(),
      headline: "h",
      url: "https://evil.test/x",
    });

    expect(made).toBeUndefined();
  });
});

describe("mergeHistory", () => {
  test("puts the new run first", () => {
    expect(mergeHistory([entry(1)], entry(2)).map((e) => e.sha)).toEqual([
      entry(2).sha,
      entry(1).sha,
    ]);
  });

  test("keeps the current run plus at most 20 earlier ones, dropping the oldest", () => {
    const previous = Array.from({ length: 30 }, (_, i) => entry(i + 1));

    const merged = mergeHistory(previous, entry(100));

    expect(merged).toHaveLength(MAX_PREVIOUS_RUNS + 1);
    expect(merged[0]).toEqual(entry(100));
    expect(merged.at(-1)).toEqual(entry(MAX_PREVIOUS_RUNS));
  });
});

describe("renderHistory and decodeHistory", () => {
  test("round-trips the entries through the hidden marker", () => {
    const entries = [entry(3), entry(2), entry(1)];

    expect(decodeHistory(`body\n${renderHistory(entries, (t) => t)}\n`)).toEqual(entries);
  });

  test("lists earlier runs newest first and leaves the current run out of the list", () => {
    const rendered = renderHistory(
      [entry(3), entry(2, { headline: "1 thing to check" })],
      (t) => t,
    );

    expect(rendered).toContain("<summary>Previous runs</summary>");
    expect(rendered).toContain(
      "- `0000002` · 2026-10-28 09:05 UTC · 1 thing to check · [run](https://github.com/o/r/actions/runs/2)",
    );
    expect(rendered).not.toContain("0000003` ·");
  });

  test("shows no list for a first run", () => {
    expect(renderHistory([entry(1)], (t) => t)).not.toContain("Previous runs");
  });

  test.each([
    ["no marker", "plain comment"],
    ["not base64 json", "<!-- cli-bench:history bm90IGpzb24= -->"],
    ["wrong shape", `<!-- cli-bench:history ${Buffer.from('[{"sha":1}]').toString("base64")} -->`],
    [
      "a forged run link",
      `<!-- cli-bench:history ${Buffer.from(JSON.stringify([entry(1, { url: "https://evil.test/x" })])).toString("base64")} -->`,
    ],
    [
      "too many entries",
      `<!-- cli-bench:history ${Buffer.from(JSON.stringify(Array.from({ length: 22 }, (_, i) => entry(i + 1)))).toString("base64")} -->`,
    ],
  ])("treats %s as empty history", (_name, body) => {
    expect(decodeHistory(body)).toEqual([]);
  });
});
