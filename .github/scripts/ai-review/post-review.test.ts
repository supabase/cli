import { describe, expect, test } from "bun:test";
import {
  AI_REVIEW_MARKER,
  assertFindings,
  assertMergedReview,
  buildReviewPayload,
  foldInlineCommentsIntoBody,
  isSuperseded,
  type MarkedEntry,
  type MergedFinding,
  type MergedReview,
  parseDiffAnchors,
  partitionFindings,
  postConsolidatedReview,
  redactSecrets,
  redactSecretsDeep,
  renderInlineComment,
  renderReviewBody,
  type ReviewFooterInfo,
  type ReviewIo,
  type ReviewPayload,
  sanitizeFilePath,
  sanitizeModelText,
  supersededBody,
  truncateReviewBody,
} from "./post-review.ts";

// A single hunk touching file.ts lines 10-14 on the new side: line 10 is
// context, line 11 replaces a removed line, 12 is a pure addition, 13-14 are
// trailing context. Hand-computed RIGHT-side anchors: {10, 11, 12, 13, 14}.
const SINGLE_HUNK_DIFF = `diff --git a/file.ts b/file.ts
index 111..222 100644
--- a/file.ts
+++ b/file.ts
@@ -10,4 +10,5 @@ function foo() {
 context line 10
-removed line 11
+added line 11
+added line 12
 context line 13
 context line 14
`;

// Two hunks in the same file: {1,2,3} from the first hunk, {20,21,22} from
// the second (the RIGHT counter resets to each hunk's own header).
const MULTI_HUNK_DIFF = `diff --git a/multi.ts b/multi.ts
index 1..2 100644
--- a/multi.ts
+++ b/multi.ts
@@ -1,3 +1,3 @@
-old first line
+new first line
 second line
 third line
@@ -20,2 +20,3 @@
 line twenty
+inserted line
 line twenty-two
`;

// Two files, each with its own single hunk and independent anchor set.
const MULTI_FILE_DIFF = `diff --git a/first.ts b/first.ts
index 1..2 100644
--- a/first.ts
+++ b/first.ts
@@ -1,2 +1,2 @@
-old first
+new first
 second
diff --git a/second.ts b/second.ts
index 3..4 100644
--- a/second.ts
+++ b/second.ts
@@ -5,2 +5,2 @@
-old line five
+new line five
 line six
`;

// A fully deleted file: no RIGHT side exists at all.
const DELETED_FILE_DIFF = `diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
index 5..0
--- a/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line one
-line two
-line three
`;

// A brand-new file: every line is an addition, anchors {1,2,3}.
const ADDED_FILE_DIFF = `diff --git a/added.ts b/added.ts
new file mode 100644
index 0..6
--- /dev/null
+++ b/added.ts
@@ -0,0 +1,3 @@
+line one
+line two
+line three
`;

// A trailing "\ No newline at end of file" marker on both sides must not
// perturb the RIGHT counter: anchors are still {1,2}.
const NO_NEWLINE_DIFF = `diff --git a/nonewline.ts b/nonewline.ts
index 7..8 100644
--- a/nonewline.ts
+++ b/nonewline.ts
@@ -1,2 +1,2 @@
 line one
-line two
\\ No newline at end of file
+line two updated
\\ No newline at end of file
`;

// git appends a literal TAB after a `+++` path that needs quoting (here,
// because it contains a space); the tab must be stripped so anchors key on
// "has space.ts", not "has space.ts\t".
const TAB_PATH_DIFF = `diff --git a/has space.ts b/has space.ts
index 9..a 100644
--- a/has space.ts
+++ b/has space.ts\t
@@ -1,1 +1,2 @@
 context line
+added line
`;

// A pure rename (100% similarity) carries no `---`/`+++`/`@@` lines at all,
// followed by a normal file's diff — the parser must not leak state (e.g. a
// leftover `currentFile`) from the header-less rename section into the next
// file.
const RENAME_ONLY_THEN_NORMAL_DIFF = `diff --git a/old-name.ts b/new-name.ts
similarity index 100%
rename from old-name.ts
rename to new-name.ts
diff --git a/other.ts b/other.ts
index 1..2 100644
--- a/other.ts
+++ b/other.ts
@@ -1,1 +1,2 @@
 context
+added
`;

// An added line whose literal content is "++ b/not-a-real-header.ts" appears
// in the diff, prefixed by the diff's own "+", as "+++ b/not-a-real-header.ts"
// — a `+++`-lookalike that must not hijack `currentFile` because it occurs
// inside a hunk, not between a `diff --git` boundary and the first `@@`.
const PLUS_LOOKALIKE_DIFF = `diff --git a/lookalike.ts b/lookalike.ts
index 1..2 100644
--- a/lookalike.ts
+++ b/lookalike.ts
@@ -1,2 +1,3 @@
 context line
+++ b/not-a-real-header.ts
+actual added line
`;

function makeFinding(overrides: Partial<MergedFinding> = {}): MergedFinding {
  return {
    id: "f-1",
    file: "src/a.ts",
    line: 10,
    end_line: null,
    severity: "major",
    category: "bug-risk",
    claim: "Something is wrong.",
    evidence: "Concrete evidence.",
    suggested_fix: null,
    sources: ["claude"],
    adjudication: { verdict: "confirmed", reason: "Verified." },
    ...overrides,
  };
}

function makeMergedReview(overrides: Partial<MergedReview> = {}): MergedReview {
  return {
    summary: "Summary.",
    findings: [],
    stats: { claude_total: 0, codex_total: 0 },
    ...overrides,
  };
}

describe("assertFindings", () => {
  const VALID_FINDING = {
    id: "claude-1",
    file: "src/a.ts",
    line: 10,
    end_line: 12,
    severity: "major",
    category: "bug-risk",
    claim: "Possible null dereference.",
    evidence: "src/a.ts:10 reads `value.foo` without a null check.",
    suggested_fix: "Add an optional chain or early return.",
  };
  const VALID_DOC = { summary: "Nothing concerning found.", findings: [VALID_FINDING] };

  test("accepts a valid findings document", () => {
    expect(() => assertFindings(VALID_DOC)).not.toThrow();
  });

  test("accepts a document with an empty findings array", () => {
    expect(() => assertFindings({ summary: "Clean diff.", findings: [] })).not.toThrow();
  });

  test.each([
    ["a bare string", "not an object", /expected an object, got string/],
    ["a top-level array", [], /expected an object/],
    ["a document missing summary", { findings: [] }, /\$\.summary.*expected a string/],
    [
      "a document whose findings isn't an array",
      { summary: "s", findings: "nope" },
      /\$\.findings.*expected an array/,
    ],
    [
      "a document with an unexpected top-level property",
      { summary: "s", findings: [], extra: true },
      /unexpected property "extra"/,
    ],
    [
      "a findings entry that isn't an object",
      { summary: "s", findings: [null] },
      /\$\.findings\[0\].*expected an object/,
    ],
    [
      "a finding missing id",
      { summary: "s", findings: [{ ...VALID_FINDING, id: undefined }] },
      /\$\.findings\[0\]\.id.*expected a string/,
    ],
    [
      "a finding with a non-integer line",
      { summary: "s", findings: [{ ...VALID_FINDING, line: "10" }] },
      /\$\.findings\[0\]\.line.*expected an integer/,
    ],
    [
      "a finding with an invalid severity",
      { summary: "s", findings: [{ ...VALID_FINDING, severity: "blocker" }] },
      /severity must be one of critical, major, minor, nit/,
    ],
    [
      "a finding with a non-kebab-case category",
      { summary: "s", findings: [{ ...VALID_FINDING, category: "Not Kebab" }] },
      /category must be kebab-case/,
    ],
    [
      "a finding with an unexpected property",
      { summary: "s", findings: [{ ...VALID_FINDING, confidence: 0.9 }] },
      /unexpected property "confidence"/,
    ],
    [
      "a finding whose file contains a backtick",
      { summary: "s", findings: [{ ...VALID_FINDING, file: "src/a.ts`; touch pwned`" }] },
      /file path contains a disallowed character/,
    ],
    [
      "a finding whose file contains a newline",
      { summary: "s", findings: [{ ...VALID_FINDING, file: "src/a.ts\nmalicious line" }] },
      /file path contains a disallowed character/,
    ],
    [
      "a finding whose file contains an ASCII control character",
      { summary: "s", findings: [{ ...VALID_FINDING, file: `src/a.ts${String.fromCharCode(7)}` }] },
      /file path contains a disallowed character/,
    ],
    [
      "a finding whose file contains the AI review marker",
      { summary: "s", findings: [{ ...VALID_FINDING, file: `src/a.ts${AI_REVIEW_MARKER}` }] },
      /file path contains a reserved marker string/,
    ],
  ])("rejects %s", (_label, doc, expectedMessage) => {
    expect(() => assertFindings(doc)).toThrow(expectedMessage);
  });
});

describe("assertMergedReview", () => {
  const VALID_FINDING = {
    id: "claude-1",
    file: "src/a.ts",
    line: 10,
    end_line: null,
    severity: "major",
    category: "bug-risk",
    claim: "Possible null dereference.",
    evidence: "src/a.ts:10 reads `value.foo` without a null check.",
    suggested_fix: null,
    sources: ["claude"],
    adjudication: { verdict: "confirmed", reason: "Verified against the code." },
  };
  const VALID_STATS = { claude_total: 1, codex_total: 0 };
  const VALID_DOC = {
    summary: "Merged summary after adjudication.",
    findings: [VALID_FINDING],
    stats: VALID_STATS,
  };

  test("accepts a valid merged review", () => {
    expect(() => assertMergedReview(VALID_DOC)).not.toThrow();
  });

  test.each([
    ["a bare number", 42, /expected an object, got number/],
    [
      "a finding missing a required key",
      { ...VALID_DOC, findings: [{ ...VALID_FINDING, id: undefined }] },
      /\$\.findings\[0\]\.id.*expected a string/,
    ],
    [
      "an end_line that is neither null nor an integer",
      { ...VALID_DOC, findings: [{ ...VALID_FINDING, end_line: "12" }] },
      /\$\.findings\[0\]\.end_line.*expected an integer/,
    ],
    [
      "a suggested_fix that is neither null nor a string",
      { ...VALID_DOC, findings: [{ ...VALID_FINDING, suggested_fix: 42 }] },
      /\$\.findings\[0\]\.suggested_fix.*expected a string/,
    ],
    [
      "an invalid source in the sources array",
      { ...VALID_DOC, findings: [{ ...VALID_FINDING, sources: ["claude", "chatgpt"] }] },
      /source must be "claude" or "codex"/,
    ],
    [
      "an empty sources array",
      { ...VALID_DOC, findings: [{ ...VALID_FINDING, sources: [] }] },
      /expected at least one source/,
    ],
    [
      "an invalid adjudication verdict",
      {
        ...VALID_DOC,
        findings: [{ ...VALID_FINDING, adjudication: { verdict: "maybe", reason: "r" } }],
      },
      /verdict must be one of confirmed, refuted, uncertain/,
    ],
    [
      "an unexpected property on the adjudication object",
      {
        ...VALID_DOC,
        findings: [
          {
            ...VALID_FINDING,
            adjudication: { verdict: "confirmed", reason: "r", confidence: 0.9 },
          },
        ],
      },
      /unexpected property "confidence"/,
    ],
    [
      "an unexpected property on a finding",
      { ...VALID_DOC, findings: [{ ...VALID_FINDING, confidence: 0.9 }] },
      /unexpected property "confidence"/,
    ],
    [
      "stats missing a required key",
      { ...VALID_DOC, stats: { ...VALID_STATS, claude_total: undefined } },
      /\$\.stats\.claude_total.*expected an integer/,
    ],
    [
      "stats with an unexpected property",
      { ...VALID_DOC, stats: { ...VALID_STATS, extra: 1 } },
      /unexpected property "extra"/,
    ],
    [
      "an unexpected top-level property",
      { ...VALID_DOC, extra: true },
      /unexpected property "extra"/,
    ],
    [
      "a finding whose file contains a backtick",
      { ...VALID_DOC, findings: [{ ...VALID_FINDING, file: "src/a.ts`; touch pwned`" }] },
      /file path contains a disallowed character/,
    ],
    [
      "a finding whose file contains a newline",
      { ...VALID_DOC, findings: [{ ...VALID_FINDING, file: "src/a.ts\nmalicious line" }] },
      /file path contains a disallowed character/,
    ],
    [
      "a finding whose file contains the superseded marker",
      {
        ...VALID_DOC,
        findings: [{ ...VALID_FINDING, file: "src/a.ts<!-- supabase-ai-review:superseded -->" }],
      },
      /file path contains a reserved marker string/,
    ],
  ])("rejects %s", (_label, doc, expectedMessage) => {
    expect(() => assertMergedReview(doc)).toThrow(expectedMessage);
  });
});

describe("parseDiffAnchors", () => {
  test("single hunk: context and added lines advance the RIGHT counter, removed lines don't", () => {
    const anchors = parseDiffAnchors(SINGLE_HUNK_DIFF);
    expect(anchors.get("file.ts")).toEqual(new Set([10, 11, 12, 13, 14]));
  });

  test("multiple hunks in the same file each reset the RIGHT counter to their own header", () => {
    const anchors = parseDiffAnchors(MULTI_HUNK_DIFF);
    expect(anchors.get("multi.ts")).toEqual(new Set([1, 2, 3, 20, 21, 22]));
  });

  test("multiple files in one diff get independent anchor sets", () => {
    const anchors = parseDiffAnchors(MULTI_FILE_DIFF);
    expect(anchors.get("first.ts")).toEqual(new Set([1, 2]));
    expect(anchors.get("second.ts")).toEqual(new Set([5, 6]));
  });

  test("a deleted file has no RIGHT-side anchors", () => {
    const anchors = parseDiffAnchors(DELETED_FILE_DIFF);
    expect(anchors.has("deleted.ts")).toBe(false);
  });

  test("an added file anchors every line", () => {
    const anchors = parseDiffAnchors(ADDED_FILE_DIFF);
    expect(anchors.get("added.ts")).toEqual(new Set([1, 2, 3]));
  });

  test("a trailing 'No newline at end of file' marker doesn't perturb the RIGHT counter", () => {
    const anchors = parseDiffAnchors(NO_NEWLINE_DIFF);
    expect(anchors.get("nonewline.ts")).toEqual(new Set([1, 2]));
  });

  test("an empty diff produces no anchors", () => {
    expect(parseDiffAnchors("").size).toBe(0);
  });

  test("strips a trailing TAB git appends after a quoted path", () => {
    const anchors = parseDiffAnchors(TAB_PATH_DIFF);
    expect(anchors.get("has space.ts")).toEqual(new Set([1, 2]));
    expect(anchors.has("has space.ts\t")).toBe(false);
  });

  test("a header-less rename-only section doesn't leak state into the next file's diff", () => {
    const anchors = parseDiffAnchors(RENAME_ONLY_THEN_NORMAL_DIFF);
    expect(anchors.has("old-name.ts")).toBe(false);
    expect(anchors.has("new-name.ts")).toBe(false);
    expect(anchors.get("other.ts")).toEqual(new Set([1, 2]));
  });

  test("a +++-lookalike content line inside a hunk doesn't hijack currentFile", () => {
    const anchors = parseDiffAnchors(PLUS_LOOKALIKE_DIFF);
    expect(anchors.get("lookalike.ts")).toEqual(new Set([1, 2, 3]));
    expect(anchors.has("not-a-real-header.ts")).toBe(false);
  });
});

describe("partitionFindings", () => {
  const anchors = parseDiffAnchors(SINGLE_HUNK_DIFF); // file.ts: {10,11,12,13,14}

  test("a confirmed finding on an anchorable line is inline-commentable", () => {
    const finding = makeFinding({
      file: "file.ts",
      line: 10,
      adjudication: { verdict: "confirmed", reason: "r" },
    });
    const result = partitionFindings([finding], anchors);
    expect(result).toEqual({ anchorable: [finding], nonAnchorable: [], refuted: [] });
  });

  test("an uncertain finding on an anchorable line is inline-commentable", () => {
    const finding = makeFinding({
      file: "file.ts",
      line: 12,
      adjudication: { verdict: "uncertain", reason: "r" },
    });
    const result = partitionFindings([finding], anchors);
    expect(result.anchorable).toEqual([finding]);
  });

  test("a confirmed finding outside the diff hunk goes to the body-only bucket", () => {
    const finding = makeFinding({
      file: "file.ts",
      line: 999,
      adjudication: { verdict: "confirmed", reason: "r" },
    });
    const result = partitionFindings([finding], anchors);
    expect(result).toEqual({ anchorable: [], nonAnchorable: [finding], refuted: [] });
  });

  test("a finding on a file with no diff anchors at all goes to the body-only bucket", () => {
    const finding = makeFinding({
      file: "unknown.ts",
      line: 1,
      adjudication: { verdict: "confirmed", reason: "r" },
    });
    const result = partitionFindings([finding], anchors);
    expect(result.nonAnchorable).toEqual([finding]);
  });

  test("refuted findings always go to the refuted bucket regardless of anchorability", () => {
    const anchorableRefuted = makeFinding({
      file: "file.ts",
      line: 10,
      adjudication: { verdict: "refuted", reason: "r" },
    });
    const nonAnchorableRefuted = makeFinding({
      file: "file.ts",
      line: 999,
      adjudication: { verdict: "refuted", reason: "r" },
    });
    const result = partitionFindings([anchorableRefuted, nonAnchorableRefuted], anchors);
    expect(result).toEqual({
      anchorable: [],
      nonAnchorable: [],
      refuted: [anchorableRefuted, nonAnchorableRefuted],
    });
  });
});

describe("renderInlineComment", () => {
  test("includes the suggested fix when present", () => {
    const finding = makeFinding({ suggested_fix: "Use optional chaining." });
    expect(renderInlineComment(finding)).toContain("**Suggested fix:** Use optional chaining.");
  });

  test("omits the suggested fix section when null", () => {
    const finding = makeFinding({ suggested_fix: null });
    expect(renderInlineComment(finding)).not.toContain("Suggested fix");
  });

  test("includes the adjudication reason only for uncertain findings", () => {
    const confirmed = makeFinding({ adjudication: { verdict: "confirmed", reason: "checked" } });
    const uncertain = makeFinding({ adjudication: { verdict: "uncertain", reason: "unclear" } });
    expect(renderInlineComment(confirmed)).not.toContain("Adjudication (uncertain)");
    expect(renderInlineComment(uncertain)).toContain("**Adjudication (uncertain):** unclear");
  });

  test("shows the severity badge, category, and joined sources", () => {
    const finding = makeFinding({
      severity: "critical",
      category: "security",
      sources: ["claude", "codex"],
    });
    const body = renderInlineComment(finding);
    expect(body).toContain("🔴 CRITICAL");
    expect(body).toContain("`security`");
    expect(body).toContain("claude+codex");
  });
});

describe("renderReviewBody", () => {
  const footer: ReviewFooterInfo = {
    trigger: "auto",
    runUrl: "https://example.com/run/9",
    modelsFooter: "`claude-fable-5` + `gpt-5.6-sol`",
  };

  test("shows 'No issues found.' when nothing was posted", () => {
    const review = makeMergedReview({ findings: [] });
    const body = renderReviewBody(
      review,
      { anchorable: [], nonAnchorable: [], refuted: [] },
      footer,
    );
    expect(body).toContain("No issues found.");
  });

  test("lists non-anchorable findings in a dedicated out-of-diff section", () => {
    const finding = makeFinding({ file: "src/a.ts", line: 5 });
    const review = makeMergedReview({ findings: [finding] });
    const body = renderReviewBody(
      review,
      { anchorable: [], nonAnchorable: [finding], refuted: [] },
      footer,
    );
    expect(body).toContain("### Findings outside the diff");
    expect(body).toContain(finding.claim);
  });

  test("includes the trigger and run URL in the footer", () => {
    const review = makeMergedReview({ findings: [] });
    const body = renderReviewBody(
      review,
      { anchorable: [], nonAnchorable: [], refuted: [] },
      footer,
    );
    expect(body).toContain("Trigger: `auto`");
    expect(body).toContain(footer.runUrl);
  });

  test("computes confirmed/refuted/uncertain stats locally from the findings' verdicts", () => {
    const confirmed = makeFinding({
      id: "f-1",
      adjudication: { verdict: "confirmed", reason: "r" },
    });
    const refuted = makeFinding({ id: "f-2", adjudication: { verdict: "refuted", reason: "r" } });
    const uncertain1 = makeFinding({
      id: "f-3",
      adjudication: { verdict: "uncertain", reason: "r" },
    });
    const uncertain2 = makeFinding({
      id: "f-4",
      adjudication: { verdict: "uncertain", reason: "r" },
    });
    const review = makeMergedReview({
      findings: [confirmed, refuted, uncertain1, uncertain2],
      stats: { claude_total: 40, codex_total: 2 },
    });
    const body = renderReviewBody(
      review,
      { anchorable: [confirmed], nonAnchorable: [uncertain1, uncertain2], refuted: [refuted] },
      footer,
    );
    expect(body).toContain("Claude findings: 40");
    expect(body).toContain("Codex findings: 2");
    expect(body).toContain("Confirmed: 1");
    expect(body).toContain("Refuted: 1");
    expect(body).toContain("Uncertain: 2");
  });

  test("sanitizes model-provided summary, claim, and refuted reason at render time", () => {
    const refuted = makeFinding({
      claim: "Ping @maintainer about #123",
      adjudication: { verdict: "refuted", reason: "See @someone / #456" },
    });
    const review = makeMergedReview({
      summary: `Injected marker <!-- supabase-ai-review:superseded --> and @user`,
      findings: [refuted],
    });
    const body = renderReviewBody(
      review,
      { anchorable: [], nonAnchorable: [], refuted: [refuted] },
      footer,
    );
    expect(body).not.toContain("<!-- supabase-ai-review:superseded -->");
    expect(body).not.toContain("@user");
    expect(body).not.toContain("@maintainer");
    expect(body).not.toContain("@someone");
    expect(body).not.toContain("#123");
    expect(body).not.toContain("#456");
    expect(body).toContain("@<!---->user");
  });

  test("neutralizes a backtick-bearing file at every code-span render site", () => {
    const maliciousFile = "src/a.ts`<script>alert(1)</script>`";
    const anchorable = makeFinding({
      id: "f-anchorable",
      file: maliciousFile,
      adjudication: { verdict: "confirmed", reason: "r" },
    });
    const nonAnchorable = makeFinding({
      id: "f-nonanchorable",
      file: maliciousFile,
      adjudication: { verdict: "confirmed", reason: "r" },
    });
    const refuted = makeFinding({
      id: "f-refuted",
      file: maliciousFile,
      adjudication: { verdict: "refuted", reason: "r" },
    });
    const review = makeMergedReview({ findings: [anchorable, nonAnchorable, refuted] });
    const body = renderReviewBody(
      review,
      { anchorable: [anchorable], nonAnchorable: [nonAnchorable], refuted: [refuted] },
      footer,
    );
    expect(body).not.toContain(maliciousFile);
    expect(body).not.toContain("`src/a.ts`");
  });

  test("redacts a secret-shaped substring embedded in model-provided text", () => {
    const finding = makeFinding({
      claim: "Found ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 in the diff.",
      adjudication: { verdict: "confirmed", reason: "r" },
    });
    const review = makeMergedReview({ findings: [finding] });
    const body = renderReviewBody(
      review,
      { anchorable: [], nonAnchorable: [finding], refuted: [] },
      footer,
    );
    expect(body).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345");
    expect(body).toContain("«redacted»");
  });
});

describe("buildReviewPayload", () => {
  const anchors = parseDiffAnchors(SINGLE_HUNK_DIFF); // file.ts: {10,11,12,13,14}
  const footer: ReviewFooterInfo = {
    trigger: "manual",
    runUrl: "https://example.com/run/1",
    modelsFooter: "`claude-fable-5` + `gpt-5.6-sol`",
  };

  test("event is always COMMENT", () => {
    const review = makeMergedReview({ findings: [] });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.event).toBe("COMMENT");
  });

  test("the review body carries the dedup marker", () => {
    const review = makeMergedReview({ findings: [] });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.body).toContain(AI_REVIEW_MARKER);
  });

  test("the injected models footer appears in the body verbatim", () => {
    const review = makeMergedReview({ findings: [] });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.body).toContain(footer.modelsFooter);
  });

  test("an anchorable single-line finding becomes an inline comment on RIGHT", () => {
    const finding = makeFinding({ file: "file.ts", line: 10, end_line: null });
    const review = makeMergedReview({ findings: [finding] });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.comments).toEqual([
      { path: "file.ts", line: 10, side: "RIGHT", body: renderInlineComment(finding) },
    ]);
  });

  test("an anchorable multi-line finding carries start_line/start_side", () => {
    const finding = makeFinding({ file: "file.ts", line: 10, end_line: 12 });
    const review = makeMergedReview({ findings: [finding] });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.comments).toEqual([
      {
        path: "file.ts",
        start_line: 10,
        start_side: "RIGHT",
        line: 12,
        side: "RIGHT",
        body: renderInlineComment(finding),
      },
    ]);
  });

  test("a multi-line finding whose end_line isn't anchorable falls back to a single-line comment", () => {
    const finding = makeFinding({ file: "file.ts", line: 10, end_line: 999 });
    const review = makeMergedReview({ findings: [finding] });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.comments).toEqual([
      { path: "file.ts", line: 10, side: "RIGHT", body: renderInlineComment(finding) },
    ]);
  });

  test("a finding with end_line === line falls back to a single-line comment (GitHub 422s start_line === line)", () => {
    const finding = makeFinding({ file: "file.ts", line: 11, end_line: 11 });
    const review = makeMergedReview({ findings: [finding] });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.comments).toEqual([
      { path: "file.ts", line: 11, side: "RIGHT", body: renderInlineComment(finding) },
    ]);
  });

  test("a finding with end_line < line falls back to a single-line comment", () => {
    const finding = makeFinding({ file: "file.ts", line: 12, end_line: 10 });
    const review = makeMergedReview({ findings: [finding] });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.comments).toEqual([
      { path: "file.ts", line: 12, side: "RIGHT", body: renderInlineComment(finding) },
    ]);
  });

  test("refuted findings render inside a collapsed details block with their reasons, never as comments", () => {
    const refuted = makeFinding({
      file: "file.ts",
      line: 10,
      adjudication: {
        verdict: "refuted",
        reason: "The claimed bug doesn't exist; verified against the code.",
      },
    });
    const review = makeMergedReview({ findings: [refuted] });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.comments).toEqual([]);
    expect(payload.body).toContain("<details>");
    expect(payload.body).toContain("Refuted findings");
    expect(payload.body).toContain("The claimed bug doesn't exist; verified against the code.");
  });

  test("stats appear in the body, with verdict counts computed from the findings", () => {
    const review = makeMergedReview({
      findings: [
        makeFinding({ id: "f-1", line: 10, adjudication: { verdict: "confirmed", reason: "r" } }),
        makeFinding({ id: "f-2", line: 11, adjudication: { verdict: "confirmed", reason: "r" } }),
        makeFinding({ id: "f-3", line: 12, adjudication: { verdict: "refuted", reason: "r" } }),
        makeFinding({ id: "f-4", line: 13, adjudication: { verdict: "uncertain", reason: "r" } }),
      ],
      stats: { claude_total: 3, codex_total: 1 },
    });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.body).toContain("Claude findings: 3");
    expect(payload.body).toContain("Codex findings: 1");
    expect(payload.body).toContain("Confirmed: 2");
    expect(payload.body).toContain("Refuted: 1");
    expect(payload.body).toContain("Uncertain: 1");
  });

  test("the findings table orders rows by severity, critical first", () => {
    const nit = makeFinding({
      id: "f-nit",
      file: "file.ts",
      line: 10,
      severity: "nit",
      claim: "nit claim",
    });
    const critical = makeFinding({
      id: "f-crit",
      file: "file.ts",
      line: 11,
      severity: "critical",
      claim: "critical claim",
    });
    const minor = makeFinding({
      id: "f-minor",
      file: "file.ts",
      line: 12,
      severity: "minor",
      claim: "minor claim",
    });
    const major = makeFinding({
      id: "f-major",
      file: "file.ts",
      line: 13,
      severity: "major",
      claim: "major claim",
    });
    const review = makeMergedReview({ findings: [nit, critical, minor, major] });
    const payload = buildReviewPayload(review, anchors, footer);
    const claimOrder = [critical.claim, major.claim, minor.claim, nit.claim].map((claim) =>
      payload.body.indexOf(claim),
    );
    expect(claimOrder).toEqual([...claimOrder].sort((a, b) => a - b));
  });

  test("truncates the very first payload's body when it already exceeds the cap with zero comments to fold", () => {
    // Not anchorable (line 999 is outside the diff hunk), so this produces a
    // body-only payload with no inline comments — the 422-retry fold path
    // never runs, so only truncating `buildReviewPayload`'s own body catches
    // an oversized initial POST.
    const finding = makeFinding({ file: "file.ts", line: 999, claim: "x".repeat(70_000) });
    const review = makeMergedReview({ findings: [finding] });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.comments).toEqual([]);
    expect(payload.body.length).toBeLessThanOrEqual(65536);
    expect(payload.body).toContain("truncated");
    expect(payload.body).toContain(footer.runUrl);
  });
});

describe("foldInlineCommentsIntoBody", () => {
  const anchors = parseDiffAnchors(SINGLE_HUNK_DIFF);
  const footer: ReviewFooterInfo = {
    trigger: "manual",
    runUrl: "https://example.com/run/1",
    modelsFooter: "`claude-fable-5` + `gpt-5.6-sol`",
  };

  test("returns the same payload unchanged when there are no inline comments", () => {
    const review = makeMergedReview({ findings: [] });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.comments).toEqual([]);
    expect(foldInlineCommentsIntoBody(payload)).toBe(payload);
  });

  test("folds every inline comment into the body and clears the comments array", () => {
    const first = makeFinding({ id: "f-1", file: "file.ts", line: 10 });
    const second = makeFinding({ id: "f-2", file: "file.ts", line: 12 });
    const review = makeMergedReview({ findings: [first, second] });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.comments).toHaveLength(2);

    const folded = foldInlineCommentsIntoBody(payload);
    expect(folded.comments).toEqual([]);
    expect(folded.event).toBe("COMMENT");
    expect(folded.body).toContain("Inline comments (GitHub rejected");
    expect(folded.body).toContain("file.ts:10");
    expect(folded.body).toContain("file.ts:12");
    expect(folded.body).toContain(first.claim);
    expect(folded.body).toContain(second.claim);
  });

  test("neutralizes a backtick-bearing file when folding a comment's path into the body", () => {
    const maliciousFile = "file.ts`<!-- supabase-ai-review -->`";
    const maliciousAnchors = new Map([[maliciousFile, new Set([10])]]);
    const finding = makeFinding({ id: "f-1", file: maliciousFile, line: 10 });
    const review = makeMergedReview({ findings: [finding] });
    const payload = buildReviewPayload(review, maliciousAnchors, footer);
    expect(payload.comments).toHaveLength(1);

    const folded = foldInlineCommentsIntoBody(payload);
    expect(folded.body).not.toContain(maliciousFile);
  });
});

describe("supersededBody and isSuperseded", () => {
  test("wraps the original body content in a collapsed details block", () => {
    const original = `Old review\n${AI_REVIEW_MARKER}`;
    const wrapped = supersededBody(original);
    expect(wrapped).toContain(original);
    expect(wrapped).toContain("<details>");
    expect(wrapped).toContain("<summary>Superseded by a newer AI review</summary>");
  });

  test("isSuperseded is false for a plain body", () => {
    expect(isSuperseded(`Old review\n${AI_REVIEW_MARKER}`)).toBe(false);
  });

  test("isSuperseded is true once a body has been superseded", () => {
    expect(isSuperseded(supersededBody(`Old review\n${AI_REVIEW_MARKER}`))).toBe(true);
  });

  test("superseding an already-superseded body still reports superseded and keeps the original content", () => {
    const original = `Old review\n${AI_REVIEW_MARKER}`;
    const twiceWrapped = supersededBody(supersededBody(original));
    expect(isSuperseded(twiceWrapped)).toBe(true);
    expect(twiceWrapped).toContain(original);
  });

  test("isSuperseded checks the hidden marker, not the human-readable text a model could forge", () => {
    expect(isSuperseded("Superseded by a newer AI review (but no hidden marker present)")).toBe(
      false,
    );
  });
});

describe("sanitizeFilePath", () => {
  test("strips backticks so a file path can't break out of a code span", () => {
    expect(sanitizeFilePath("src/a.ts`injected`")).toBe("src/a.tsinjected");
  });

  test("strips '<', ASCII control characters, and DEL", () => {
    expect(
      sanitizeFilePath(`src/a.ts<!--${String.fromCharCode(7)}-->${String.fromCharCode(127)}`),
    ).toBe("src/a.ts!---->");
  });

  test("leaves an ordinary repo-relative path untouched", () => {
    expect(sanitizeFilePath("apps/cli/src/commands/login/index.ts")).toBe(
      "apps/cli/src/commands/login/index.ts",
    );
  });
});

describe("sanitizeModelText", () => {
  test("escapes a comment opener that stripping would have re-formed", () => {
    expect(sanitizeModelText("Forged <!<!---->-- supabase-ai-review:superseded --> marker")).toBe(
      "Forged <!&lt;!---->-- supabase-ai-review:superseded --> marker",
    );
  });

  test("keeps the zero-width mention and issue-ref breakers intact", () => {
    expect(sanitizeModelText("<!-- x --> @user #12")).toBe("&lt;!-- x --> @<!---->user #<!---->12");
  });
});

describe("redactSecrets", () => {
  test.each([
    ["an Anthropic API key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"],
    ["a generic OpenAI-shaped API key", "sk-abcdefghijklmnopqrstuvwxyz012345"],
    ["a project-scoped OpenAI key", "sk-proj-abcdefghijklmnopqrstuvwxyz012345"],
    ["a service-account OpenAI key", "sk-svcacct-abcdefghijklmnopqrstuvwxyz012345"],
    ["a GitHub personal access token", `ghp_${"a".repeat(36)}`],
    ["a GitHub fine-grained PAT", `github_pat_${"a".repeat(30)}`],
    ["a GitHub Actions server-to-server token", `ghs_${"a".repeat(36)}`],
  ])("redacts %s", (_label, secret) => {
    const redacted = redactSecrets(`before ${secret} after`);
    expect(redacted).not.toContain(secret);
    expect(redacted).toBe("before «redacted» after");
  });

  test("leaves ordinary text untouched", () => {
    expect(redactSecrets("Nothing sensitive here.")).toBe("Nothing sensitive here.");
  });

  test("redacts every occurrence, not just the first", () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345";
    expect(redactSecrets(`${secret} and again ${secret}`)).toBe("«redacted» and again «redacted»");
  });
});

describe("redactSecretsDeep", () => {
  test("redacts strings nested in objects and arrays, leaving other types untouched", () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345";
    const input = {
      summary: `leaked ${secret}`,
      findings: [{ claim: `also ${secret}`, line: 10, ok: true, fix: null }],
    };
    const result = redactSecretsDeep(input);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toEqual({
      summary: "leaked «redacted»",
      findings: [{ claim: "also «redacted»", line: 10, ok: true, fix: null }],
    });
  });
});

describe("truncateReviewBody", () => {
  const runUrl = "https://example.com/run/1";

  test("returns the body unchanged when it's under the cap", () => {
    expect(truncateReviewBody("short body", runUrl)).toBe("short body");
  });

  test("truncates and appends a marker with the run URL when over the cap", () => {
    const body = "x".repeat(70_000);
    const truncated = truncateReviewBody(body, runUrl);
    expect(truncated.length).toBeLessThanOrEqual(65536);
    expect(truncated).toContain("truncated");
    expect(truncated).toContain(runUrl);
  });
});

describe("post flow via injected ReviewIo", () => {
  const footer: ReviewFooterInfo = {
    trigger: "manual",
    runUrl: "https://example.com/run/1",
    modelsFooter: "`claude-fable-5` + `gpt-5.6-sol`",
  };

  function makeReviewIo(
    opts: {
      diff?: string;
      reviews?: MarkedEntry[];
      comments?: MarkedEntry[];
      postReviewStatuses?: number[];
      postReviewBodies?: Array<string | undefined>;
      failSupersede?: boolean;
    } = {},
  ): {
    io: ReviewIo;
    updatedReviews: Array<{ reviewId: number; body: string }>;
    updatedComments: Array<{ commentId: number; body: string }>;
    postedReviews: ReviewPayload[];
    postedComments: string[];
    calls: string[];
  } {
    const updatedReviews: Array<{ reviewId: number; body: string }> = [];
    const updatedComments: Array<{ commentId: number; body: string }> = [];
    const postedReviews: ReviewPayload[] = [];
    const postedComments: string[] = [];
    const calls: string[] = [];
    let postReviewCalls = 0;

    const io: ReviewIo = {
      fetchPrDiff: () => Promise.resolve(opts.diff ?? ""),
      listReviews: () => {
        calls.push("listReviews");
        if (opts.failSupersede) {
          return Promise.reject(new Error("listReviews failed"));
        }
        // Mirror real GitHub: a review posted earlier in the same run shows
        // up in later listings as a marker-bearing bot review. The supersede
        // pass must snapshot BEFORE posting or it would wrap the fresh
        // review as "superseded" too.
        const alreadyPosted = postedReviews.map((payload, i) => ({
          id: 900 + i,
          body: payload.body,
          authorLogin: "github-actions[bot]",
        }));
        return Promise.resolve([...(opts.reviews ?? []), ...alreadyPosted]);
      },
      listIssueComments: () => {
        calls.push("listIssueComments");
        return Promise.resolve(opts.comments ?? []);
      },
      updateReviewBody: (_prNumber, reviewId, body) => {
        calls.push("updateReviewBody");
        updatedReviews.push({ reviewId, body });
        return Promise.resolve();
      },
      updateIssueCommentBody: (commentId, body) => {
        calls.push("updateIssueCommentBody");
        updatedComments.push({ commentId, body });
        return Promise.resolve();
      },
      postReview: (_prNumber, payload) => {
        calls.push("postReview");
        postedReviews.push(payload);
        const status = opts.postReviewStatuses?.[postReviewCalls] ?? 200;
        const body = opts.postReviewBodies?.[postReviewCalls];
        postReviewCalls++;
        return Promise.resolve({ status, body });
      },
    };
    return { io, updatedReviews, updatedComments, postedReviews, postedComments, calls };
  }

  test("review mode supersedes only the workflow bot's marker-bearing reviews/comments, after posting", async () => {
    const priorMarkerReview = {
      id: 1,
      body: `Old review\n${AI_REVIEW_MARKER}`,
      authorLogin: "github-actions[bot]",
    };
    const humanReview = { id: 2, body: "Looks good to me!", authorLogin: "a-human-reviewer" };
    const priorMarkerComment = {
      id: 10,
      body: `Notice\n${AI_REVIEW_MARKER}`,
      authorLogin: "github-actions[bot]",
    };
    const unrelatedBotComment = {
      id: 11,
      body: "Unrelated automation comment.",
      authorLogin: "github-actions[bot]",
    };
    const alreadySupersededComment = {
      id: 12,
      body: supersededBody(`Older notice\n${AI_REVIEW_MARKER}`),
      authorLogin: "github-actions[bot]",
    };
    const impersonatorComment = {
      id: 13,
      body: `Fake review\n${AI_REVIEW_MARKER}`,
      authorLogin: "not-the-workflow-bot",
    };

    const { io, updatedReviews, updatedComments, postedReviews, calls } = makeReviewIo({
      diff: SINGLE_HUNK_DIFF,
      reviews: [priorMarkerReview, humanReview],
      comments: [
        priorMarkerComment,
        unrelatedBotComment,
        alreadySupersededComment,
        impersonatorComment,
      ],
    });

    const review = makeMergedReview({ findings: [] });
    await postConsolidatedReview(io, 42, review, footer);

    expect(updatedReviews).toEqual([{ reviewId: 1, body: supersededBody(priorMarkerReview.body) }]);
    expect(updatedComments).toEqual([
      { commentId: 10, body: supersededBody(priorMarkerComment.body) },
    ]);
    expect(postedReviews).toHaveLength(1);
    expect(postedReviews[0]?.event).toBe("COMMENT");
    expect(calls.indexOf("postReview")).toBeLessThan(calls.indexOf("updateReviewBody"));
  });

  test("the freshly posted review is never swept into its own supersede pass", async () => {
    const review = makeMergedReview({ findings: [] });
    const { io, updatedReviews, updatedComments, postedReviews, calls } = makeReviewIo({
      diff: SINGLE_HUNK_DIFF,
    });

    await postConsolidatedReview(io, 42, review, footer);

    // With no prior AI review on the PR, nothing may be wrapped as superseded
    // — especially not the review this run just posted (which the fake's
    // listReviews, like real GitHub, includes in post-POST listings).
    expect(postedReviews).toHaveLength(1);
    expect(updatedReviews).toEqual([]);
    expect(updatedComments).toEqual([]);
    expect(calls.indexOf("listReviews")).toBeLessThan(calls.indexOf("postReview"));
  });

  test("a review still posts even when the best-effort supersede fails", async () => {
    const review = makeMergedReview({ findings: [] });
    const { io, postedReviews } = makeReviewIo({ diff: SINGLE_HUNK_DIFF, failSupersede: true });
    await expect(postConsolidatedReview(io, 42, review, footer)).resolves.toBeUndefined();
    expect(postedReviews).toHaveLength(1);
  });

  test("posts exactly one review when the first POST succeeds", async () => {
    const finding = makeFinding({ file: "file.ts", line: 10 });
    const review = makeMergedReview({ findings: [finding] });
    const { io, postedReviews } = makeReviewIo({ diff: SINGLE_HUNK_DIFF });

    await postConsolidatedReview(io, 42, review, footer);

    expect(postedReviews).toHaveLength(1);
  });

  test("retries once with inline comments folded into the body when the first POST 422s", async () => {
    const finding = makeFinding({ file: "file.ts", line: 10 });
    const review = makeMergedReview({ findings: [finding] });
    const { io, postedReviews } = makeReviewIo({
      diff: SINGLE_HUNK_DIFF,
      postReviewStatuses: [422, 200],
    });

    await postConsolidatedReview(io, 42, review, footer);

    expect(postedReviews).toHaveLength(2);
    expect(postedReviews[0]?.comments).toHaveLength(1);
    expect(postedReviews[1]?.comments).toHaveLength(0);
    expect(postedReviews[1]?.body).toContain("Inline comments (GitHub rejected");
  });

  test("never retries with the fold when there were no inline comments to fold", async () => {
    const finding = makeFinding({ file: "file.ts", line: 999 }); // not anchorable -> body-only
    const review = makeMergedReview({ findings: [finding] });
    const { io, postedReviews } = makeReviewIo({
      diff: SINGLE_HUNK_DIFF,
      postReviewStatuses: [422],
    });

    await expect(postConsolidatedReview(io, 42, review, footer)).rejects.toThrow(
      /Review POST failed \(status 422\)/,
    );
    expect(postedReviews).toHaveLength(1);
  });

  test("throws with GitHub's response body when the retry also 422s, instead of swallowing it", async () => {
    const finding = makeFinding({ file: "file.ts", line: 10 });
    const review = makeMergedReview({ findings: [finding] });
    const { io, postedReviews } = makeReviewIo({
      diff: SINGLE_HUNK_DIFF,
      postReviewStatuses: [422, 422],
      postReviewBodies: [undefined, '{"message":"still invalid"}'],
    });

    await expect(postConsolidatedReview(io, 42, review, footer)).rejects.toThrow(
      /status 422.*still invalid/s,
    );
    expect(postedReviews).toHaveLength(2);
  });

  test("truncates a folded body over GitHub's 65536-char review body cap", async () => {
    const hugeClaim = "x".repeat(70_000);
    const finding = makeFinding({ file: "file.ts", line: 10, claim: hugeClaim });
    const review = makeMergedReview({ findings: [finding] });
    const { io, postedReviews } = makeReviewIo({
      diff: SINGLE_HUNK_DIFF,
      postReviewStatuses: [422, 200],
    });

    await postConsolidatedReview(io, 42, review, footer);

    const foldedBody = postedReviews[1]?.body ?? "";
    expect(foldedBody.length).toBeLessThanOrEqual(65536);
    expect(foldedBody).toContain("truncated");
    expect(foldedBody).toContain(footer.runUrl);
  });

  test("posts a truncated body on the very first attempt for an oversized body-only review (no comments to fold)", async () => {
    // Not anchorable, so there's no inline comment for GitHub to 422 on — the
    // old behavior threw here instead of posting a truncated body.
    const finding = makeFinding({ file: "file.ts", line: 999, claim: "x".repeat(70_000) });
    const review = makeMergedReview({ findings: [finding] });
    const { io, postedReviews } = makeReviewIo({ diff: SINGLE_HUNK_DIFF });

    await postConsolidatedReview(io, 42, review, footer);

    expect(postedReviews).toHaveLength(1);
    expect(postedReviews[0]?.body.length).toBeLessThanOrEqual(65536);
    expect(postedReviews[0]?.body).toContain("truncated");
  });
});
