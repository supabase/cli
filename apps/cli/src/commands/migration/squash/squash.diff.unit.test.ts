import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SQUASH_SEPARATOR_COMMENT, squashLineByLineDiff, squashScanLines } from "./squash.diff.ts";

// before.sql/after.sql/diff.sql are vendored real pg_dump output, not hand-transcribed
// literals, since manual transcription would silently corrupt whitespace/quoting.
const testdataDir = fileURLToPath(new URL("./testdata/", import.meta.url));
const readGoFixture = (name: string) => readFileSync(`${testdataDir}${name}`, "utf8");

describe("squashLineByLineDiff", () => {
  it("diffs real pg_dump output into Go's exact diff.sql bytes", () => {
    const before = readGoFixture("before.sql");
    const after = readGoFixture("after.sql");
    const expected = readGoFixture("diff.sql");
    expect(squashLineByLineDiff(before, after)).toBe(expected);
  });

  it("keeps only after-only lines when before is shorter", () => {
    const before = "select 1;";
    const after = "select 0;\nselect 1;\nselect 2;";
    expect(squashLineByLineDiff(before, after)).toBe("select 0;\nselect 2;\n");
  });

  it("emits nothing when after is shorter", () => {
    const before = "select 1;\nselect 2;";
    const after = "select 1;";
    expect(squashLineByLineDiff(before, after)).toBe("");
  });

  it("emits the single after line when nothing matches", () => {
    const before = "select 0;\nselect 1;";
    const after = "select 1;";
    expect(squashLineByLineDiff(before, after)).toBe("select 1;\n");
  });

  it('swallows every subsequent after line once before is exhausted (the anchor.Text() === "" sentinel)', () => {
    const before = "create schema test;";
    const after = "create schema test;\n\n\nselect 1;";
    expect(squashLineByLineDiff(before, after)).toBe("select 1;\n");
  });

  it("strips one trailing \\r per line like bufio.ScanLines (CRLF before, LF after)", () => {
    const before = "select 1;\r\nselect 2;\r\n";
    const after = "select 1;\nselect 2;\n";
    expect(squashLineByLineDiff(before, after)).toBe("");
  });

  it("treats a final line without a trailing newline as a token, and a trailing newline as no extra empty token", () => {
    // before has one token ("a"); after has two ("a", "b"), so only "b" is unmatched.
    const before = "a";
    const after = "a\nb\n";
    expect(squashLineByLineDiff(before, after)).toBe("b\n");
  });
});

describe("squashScanLines", () => {
  it("yields zero tokens for an empty string", () => {
    expect(squashScanLines("")).toEqual([]);
  });

  it("yields one token for a single line with no trailing newline", () => {
    expect(squashScanLines("select 1;")).toEqual(["select 1;"]);
  });

  it("drops the trailing empty token a final newline would otherwise produce", () => {
    expect(squashScanLines("a\nb\n")).toEqual(["a", "b"]);
  });

  it("keeps an interior blank line as its own empty-string token", () => {
    expect(squashScanLines("a\n\nb")).toEqual(["a", "", "b"]);
  });

  it("strips exactly one trailing \\r from every token, including the final EOF-flushed one", () => {
    expect(squashScanLines("a\r\nb\r")).toEqual(["a", "b"]);
  });

  it("does not strip more than one trailing \\r", () => {
    expect(squashScanLines("a\r\r\n")).toEqual(["a\r"]);
  });

  it("treats a lone \\r with no following \\n as part of the final token, then strips it", () => {
    expect(squashScanLines("only-cr\r")).toEqual(["only-cr"]);
  });
});

describe("SQUASH_SEPARATOR_COMMENT", () => {
  it("carries Go's leading newline before the dashed comment banner", () => {
    expect(SQUASH_SEPARATOR_COMMENT).toBe(
      "\n--\n-- Dumped schema changes for auth and storage\n--\n\n",
    );
  });

  it("starts with \\n, not with the comment banner itself", () => {
    expect(SQUASH_SEPARATOR_COMMENT.startsWith("\n--")).toBe(true);
    expect(SQUASH_SEPARATOR_COMMENT.startsWith("--")).toBe(false);
  });
});
