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
  postTooLargeNotice,
  type PrStats,
  renderInlineComment,
  renderReviewBody,
  renderTooLargeNotice,
  type ReviewFooterInfo,
  type ReviewIo,
  type ReviewPayload,
  supersededBody,
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
    stats: { claude_total: 0, codex_total: 0, confirmed: 0, refuted: 0, uncertain: 0 },
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
  const VALID_STATS = { claude_total: 1, codex_total: 0, confirmed: 1, refuted: 0, uncertain: 0 };
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
  const footer: ReviewFooterInfo = { trigger: "auto", runUrl: "https://example.com/run/9" };

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
});

describe("renderTooLargeNotice", () => {
  test("includes the diff stats and the dedup marker", () => {
    const notice = renderTooLargeNotice({ additions: 9000, deletions: 200, changedFiles: 130 });
    expect(notice).toContain("+9000/-200 lines across 130 files");
    expect(notice).toContain(AI_REVIEW_MARKER);
  });
});

describe("buildReviewPayload", () => {
  const anchors = parseDiffAnchors(SINGLE_HUNK_DIFF); // file.ts: {10,11,12,13,14}
  const footer: ReviewFooterInfo = { trigger: "manual", runUrl: "https://example.com/run/1" };

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

  test("both model names appear in the footer", () => {
    const review = makeMergedReview({ findings: [] });
    const payload = buildReviewPayload(review, anchors, footer);
    expect(payload.body).toContain("claude-fable-5");
    expect(payload.body).toContain("gpt-5.6-sol");
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

  test("stats appear in the body", () => {
    const review = makeMergedReview({
      findings: [],
      stats: { claude_total: 3, codex_total: 1, confirmed: 2, refuted: 1, uncertain: 1 },
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
});

describe("foldInlineCommentsIntoBody", () => {
  const anchors = parseDiffAnchors(SINGLE_HUNK_DIFF);
  const footer: ReviewFooterInfo = { trigger: "manual", runUrl: "https://example.com/run/1" };

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
});

describe("post flow via injected ReviewIo", () => {
  function makeReviewIo(
    opts: {
      diff?: string;
      stats?: PrStats;
      reviews?: MarkedEntry[];
      comments?: MarkedEntry[];
      postReviewStatuses?: number[];
    } = {},
  ): {
    io: ReviewIo;
    updatedReviews: Array<{ reviewId: number; body: string }>;
    updatedComments: Array<{ commentId: number; body: string }>;
    postedReviews: ReviewPayload[];
    postedComments: string[];
  } {
    const updatedReviews: Array<{ reviewId: number; body: string }> = [];
    const updatedComments: Array<{ commentId: number; body: string }> = [];
    const postedReviews: ReviewPayload[] = [];
    const postedComments: string[] = [];
    let postReviewCalls = 0;

    const io: ReviewIo = {
      fetchPrDiff: () => Promise.resolve(opts.diff ?? ""),
      fetchPrStats: () =>
        Promise.resolve(opts.stats ?? { additions: 0, deletions: 0, changedFiles: 0 }),
      listReviews: () => Promise.resolve(opts.reviews ?? []),
      listIssueComments: () => Promise.resolve(opts.comments ?? []),
      updateReviewBody: (_prNumber, reviewId, body) => {
        updatedReviews.push({ reviewId, body });
        return Promise.resolve();
      },
      updateIssueCommentBody: (commentId, body) => {
        updatedComments.push({ commentId, body });
        return Promise.resolve();
      },
      postReview: (_prNumber, payload) => {
        postedReviews.push(payload);
        const status = opts.postReviewStatuses?.[postReviewCalls] ?? 200;
        postReviewCalls++;
        return Promise.resolve({ status });
      },
      postIssueComment: (_prNumber, body) => {
        postedComments.push(body);
        return Promise.resolve();
      },
    };
    return { io, updatedReviews, updatedComments, postedReviews, postedComments };
  }

  test("too-large mode posts exactly one issue comment carrying the marker", async () => {
    const { io, postedComments } = makeReviewIo({
      stats: { additions: 9000, deletions: 100, changedFiles: 50 },
    });
    await postTooLargeNotice(io, 42);
    expect(postedComments).toHaveLength(1);
    expect(postedComments[0]).toContain(AI_REVIEW_MARKER);
    expect(postedComments[0]).toContain("too large for a full AI review");
  });

  test("review mode supersedes only the workflow bot's marker-bearing reviews/comments, then posts one review", async () => {
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

    const { io, updatedReviews, updatedComments, postedReviews } = makeReviewIo({
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
    await postConsolidatedReview(io, 42, review, {
      trigger: "manual",
      runUrl: "https://example.com/run/1",
    });

    expect(updatedReviews).toEqual([{ reviewId: 1, body: supersededBody(priorMarkerReview.body) }]);
    expect(updatedComments).toEqual([
      { commentId: 10, body: supersededBody(priorMarkerComment.body) },
    ]);
    expect(postedReviews).toHaveLength(1);
    expect(postedReviews[0]?.event).toBe("COMMENT");
  });

  test("posts exactly one review when the first POST succeeds", async () => {
    const finding = makeFinding({ file: "file.ts", line: 10 });
    const review = makeMergedReview({ findings: [finding] });
    const { io, postedReviews } = makeReviewIo({ diff: SINGLE_HUNK_DIFF });

    await postConsolidatedReview(io, 42, review, {
      trigger: "auto",
      runUrl: "https://example.com/run/3",
    });

    expect(postedReviews).toHaveLength(1);
  });

  test("retries once with inline comments folded into the body when the first POST 422s", async () => {
    const finding = makeFinding({ file: "file.ts", line: 10 });
    const review = makeMergedReview({ findings: [finding] });
    const { io, postedReviews } = makeReviewIo({
      diff: SINGLE_HUNK_DIFF,
      postReviewStatuses: [422, 200],
    });

    await postConsolidatedReview(io, 42, review, {
      trigger: "auto",
      runUrl: "https://example.com/run/2",
    });

    expect(postedReviews).toHaveLength(2);
    expect(postedReviews[0]?.comments).toHaveLength(1);
    expect(postedReviews[1]?.comments).toHaveLength(0);
    expect(postedReviews[1]?.body).toContain("Inline comments (GitHub rejected");
  });
});
