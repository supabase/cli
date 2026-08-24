import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  LEGACY_SQUASH_SEPARATOR_COMMENT,
  legacySquashLineByLineDiff,
  legacySquashScanLines,
} from "./squash.diff.ts";

/**
 * The `before.sql`/`after.sql`/`diff.sql` fixtures are vendored copies of real
 * `pg_dump` output rather than hand-transcribed template literals: a byte-for-byte
 * corpus of 90+109+19 lines is exactly the kind of content a manual transcription
 * would silently corrupt (trailing whitespace, blank lines, quoting).
 */
const readGoFixtures = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const testdataDir = yield* path.fromFileUrl(new URL("./testdata/", import.meta.url));
  return yield* Effect.all({
    before: fs.readFileString(path.join(testdataDir, "before.sql")),
    after: fs.readFileString(path.join(testdataDir, "after.sql")),
    expected: fs.readFileString(path.join(testdataDir, "diff.sql")),
  });
});

describe("legacySquashLineByLineDiff", () => {
  it("diffs real pg_dump output into Go's exact diff.sql bytes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { before, after, expected } = yield* readGoFixtures;
        expect(legacySquashLineByLineDiff(before, after)).toBe(expected);
      }).pipe(Effect.provide(BunServices.layer)),
    ));

  it("keeps only after-only lines when before is shorter", () => {
    const before = "select 1;";
    const after = "select 0;\nselect 1;\nselect 2;";
    expect(legacySquashLineByLineDiff(before, after)).toBe("select 0;\nselect 2;\n");
  });

  it("emits nothing when after is shorter", () => {
    const before = "select 1;\nselect 2;";
    const after = "select 1;";
    expect(legacySquashLineByLineDiff(before, after)).toBe("");
  });

  it("emits the single after line when nothing matches", () => {
    const before = "select 0;\nselect 1;";
    const after = "select 1;";
    expect(legacySquashLineByLineDiff(before, after)).toBe("select 1;\n");
  });

  it('swallows every subsequent after line once before is exhausted (the anchor.Text() === "" sentinel)', () => {
    // Once `before` runs out of tokens, the anchor text returns `""` forever, so a
    // blank line in `after` matches that sentinel and is silently dropped — NOT emitted
    // as if it were an unmatched line. `before` has a single non-blank token; every
    // remaining `after` line (including two literal blank lines) must vanish.
    const before = "create schema test;";
    const after = "create schema test;\n\n\nselect 1;";
    expect(legacySquashLineByLineDiff(before, after)).toBe("select 1;\n");
  });

  it("strips one trailing \\r per line like bufio.ScanLines (CRLF before, LF after)", () => {
    const before = "select 1;\r\nselect 2;\r\n";
    const after = "select 1;\nselect 2;\n";
    // After stripping the trailing \r from each `before` token, every `after` line
    // matches its anchor — the diff is empty.
    expect(legacySquashLineByLineDiff(before, after)).toBe("");
  });

  it("treats a final line without a trailing newline as a token, and a trailing newline as no extra empty token", () => {
    // `before` has no trailing newline (one token, "a"); `after` DOES (two tokens: "a",
    // "b"), so only "b" is unmatched — a final "\n" must not manufacture a phantom empty
    // token that would otherwise consume the "b" match or emit an extra blank line.
    const before = "a";
    const after = "a\nb\n";
    expect(legacySquashLineByLineDiff(before, after)).toBe("b\n");
  });
});

describe("legacySquashScanLines", () => {
  it("yields zero tokens for an empty string", () => {
    expect(legacySquashScanLines("")).toEqual([]);
  });

  it("yields one token for a single line with no trailing newline", () => {
    expect(legacySquashScanLines("select 1;")).toEqual(["select 1;"]);
  });

  it("drops the trailing empty token a final newline would otherwise produce", () => {
    expect(legacySquashScanLines("a\nb\n")).toEqual(["a", "b"]);
  });

  it("keeps an interior blank line as its own empty-string token", () => {
    expect(legacySquashScanLines("a\n\nb")).toEqual(["a", "", "b"]);
  });

  it("strips exactly one trailing \\r from every token, including the final EOF-flushed one", () => {
    expect(legacySquashScanLines("a\r\nb\r")).toEqual(["a", "b"]);
  });

  it("does not strip more than one trailing \\r", () => {
    expect(legacySquashScanLines("a\r\r\n")).toEqual(["a\r"]);
  });

  it("treats a lone \\r with no following \\n as part of the final token, then strips it", () => {
    expect(legacySquashScanLines("only-cr\r")).toEqual(["only-cr"]);
  });
});

describe("LEGACY_SQUASH_SEPARATOR_COMMENT", () => {
  it("carries Go's leading newline before the dashed comment banner", () => {
    expect(LEGACY_SQUASH_SEPARATOR_COMMENT).toBe(
      "\n--\n-- Dumped schema changes for auth and storage\n--\n\n",
    );
  });

  it("starts with \\n, not with the comment banner itself", () => {
    expect(LEGACY_SQUASH_SEPARATOR_COMMENT.startsWith("\n--")).toBe(true);
    expect(LEGACY_SQUASH_SEPARATOR_COMMENT.startsWith("--")).toBe(false);
  });
});
