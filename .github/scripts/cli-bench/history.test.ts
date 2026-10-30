import { describe, expect, test } from "bun:test";
import {
  decodeHistory,
  headlineOf,
  makeEntry,
  MAX_PREVIOUS_RUNS,
  mergeHistory,
  previousEntries,
  renderHistory,
  type RunEntry,
} from "./history.ts";

const entry = (n: number, overrides: Partial<RunEntry> = {}): RunEntry => ({
  section: "lightweight",
  sha: n.toString(16).padStart(7, "0"),
  at: "2026-10-28T09:05Z",
  headline: "no changes found",
  url: `https://github.com/o/r/actions/runs/${n}`,
  ...overrides,
});
const heavy = (n: number, overrides: Partial<RunEntry> = {}) =>
  entry(n, { section: "integration-heavy", ...overrides });

describe("headlineOf", () => {
  test.each([
    ["a comment section", "### Lightweight Commands: 2 things to check\n\nbody"],
    ["an integration-heavy section", "### Integration Heavy Commands: 2 things to check\n\nbody"],
    ["a job summary", "## CLI benchmark: 2 things to check\n\nbody"],
    [
      "an integration-heavy job summary",
      "## CLI benchmark (Integration Heavy Commands): 2 things to check",
    ],
  ])("reads the title of %s", (_name, markdown) => {
    expect(headlineOf(markdown)).toBe("2 things to check");
  });

  test("falls back when the report has no title", () => {
    expect(headlineOf("nothing here")).toBe("unknown");
  });
});

describe("makeEntry", () => {
  test("shortens the commit and rounds the time down to the minute in UTC", () => {
    const made = makeEntry({
      section: "integration-heavy",
      sha: "0123456789abcdef0123456789abcdef01234567",
      now: new Date("2026-10-28T09:05:59Z"),
      headline: "no changes found",
      url: "https://github.com/o/r/actions/runs/9/attempts/2",
    });

    expect(made).toMatchObject({
      section: "integration-heavy",
      sha: "0123456",
      at: "2026-10-28T09:05Z",
    });
  });

  test("refuses a run link that is not a workflow run", () => {
    const made = makeEntry({
      section: "lightweight",
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

  test("keeps each section's newest run plus at most 20 older ones across both sections", () => {
    const previous = [
      ...Array.from({ length: 15 }, (_, i) => entry(100 - i)),
      heavy(50),
      ...Array.from({ length: 15 }, (_, i) => heavy(40 - i)),
    ];

    const merged = mergeHistory(previous, entry(200));

    const older = merged.length - 2;
    expect(older).toBe(MAX_PREVIOUS_RUNS);
    expect(merged[0]).toEqual(entry(200));
    expect(merged.filter((e) => e.section === "integration-heavy")[0]).toEqual(heavy(50));
  });

  test("keeps a section's newest run even when the other section has filled the list", () => {
    const previous = [...Array.from({ length: 25 }, (_, i) => entry(100 - i)), heavy(5)];

    const merged = mergeHistory(previous, entry(200));

    expect(merged.at(-1)).toEqual(heavy(5));
  });
});

describe("previousEntries", () => {
  test("leaves out each section's newest entry, which is its current result", () => {
    const entries = [entry(4), heavy(3), entry(2), heavy(1)];

    expect(previousEntries(entries)).toEqual([entry(2), heavy(1)]);
  });

  test("lists every entry of a section that is running, since it has no current result", () => {
    const entries = [entry(4), heavy(3), entry(2), heavy(1)];

    expect(previousEntries(entries, new Set(["integration-heavy"]))).toEqual([
      heavy(3),
      entry(2),
      heavy(1),
    ]);
  });
});

describe("renderHistory and decodeHistory", () => {
  test("reads an entry written before sections existed as a lightweight run", () => {
    const legacy = { ...entry(1), section: undefined };
    const body = `<!-- cli-bench:history ${Buffer.from(JSON.stringify([legacy])).toString("base64")} -->`;

    expect(decodeHistory(body)).toEqual([entry(1)]);
  });

  test("round-trips the entries through the hidden marker", () => {
    const entries = [entry(3), heavy(2), entry(1)];

    expect(decodeHistory(`body\n${renderHistory(entries, (t) => t)}\n`)).toEqual(entries);
  });

  test("names the section of each replaced run and leaves current results out of the list", () => {
    const rendered = renderHistory(
      [entry(4), heavy(3), heavy(2, { headline: "1 thing to check" })],
      (t) => t,
    );

    expect(rendered).toContain("<summary>Previous runs</summary>");
    expect(rendered).toContain(
      "- Integration Heavy Commands · `0000002` · 2026-10-28 09:05 UTC · 1 thing to check · [run](https://github.com/o/r/actions/runs/2)",
    );
    expect(rendered).not.toContain("0000003` ·");
    expect(rendered).not.toContain("0000004` ·");
  });

  test("shows no list while every section has a single run", () => {
    expect(renderHistory([entry(1), heavy(2)], (t) => t)).not.toContain("Previous runs");
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
      `<!-- cli-bench:history ${Buffer.from(JSON.stringify(Array.from({ length: 23 }, (_, i) => entry(i + 1)))).toString("base64")} -->`,
    ],
  ])("treats %s as empty history", (_name, body) => {
    expect(decodeHistory(body)).toEqual([]);
  });
});
