/**
 * AI review poster: validates the structured findings both model passes
 * produce, and posts the ONE consolidated PR review the pipeline is allowed
 * to post per run.
 *
 * Three subcommands, dispatched from `argv`:
 *   - `validate-findings <path>` — checks a Claude findings JSON file against
 *     the shape `.github/ai-review/findings.schema.json` describes. The
 *     `--json-schema` flag passed to `claude` is a hint to the model, not a
 *     runtime guarantee, so the CI step re-checks the extracted output here
 *     before it is trusted.
 *   - `validate-merged <path>` — same idea for the Codex-adjudicated merged
 *     review, against `.github/ai-review/merged-review.schema.json`.
 *   - `post` — reads `$MODE` (`review` | `too-large`) and posts either a
 *     "diff too large" notice or the consolidated review, superseding any
 *     prior AI review on the PR first (the marker/dedup guard in
 *     `resolve.ts` should normally prevent a second run, but `/ai-review`
 *     lets a maintainer force one).
 *
 * `parseDiffAnchors`, `partitionFindings`, `renderReviewBody`,
 * `renderInlineComment`, `buildReviewPayload`, `foldInlineCommentsIntoBody`,
 * `supersededBody`, and `isSuperseded` are pure and exported for tests.
 * `postTooLargeNotice` and `postConsolidatedReview` are the I/O orchestration
 * functions for the `post` subcommand's two modes; they're exported so a test
 * can drive them against an injected `ReviewIo` fake without the network, the
 * same way `resolveDecision` is tested in `resolve.ts`. `main()` wires up the
 * real GitHub I/O and argv dispatch.
 *
 * Run in CI as: `bun .github/scripts/ai-review/post-review.ts <command>`.
 */

export const AI_REVIEW_MARKER = "<!-- supabase-ai-review -->";
const SUPERSEDED_SUMMARY = "Superseded by a newer AI review";
const WORKFLOW_BOT_LOGIN = "github-actions[bot]";
const MODELS_FOOTER = "`claude-fable-5` + `gpt-5.6-sol`";

// --- Shared types (mirror the two schema files by hand; keep in sync) ---

export type Severity = "critical" | "major" | "minor" | "nit";
export type Verdict = "confirmed" | "refuted" | "uncertain";
export type Source = "claude" | "codex";
export type Trigger = "auto" | "manual";
export type Mode = "review" | "too-large";

export interface Finding {
  id: string;
  file: string;
  line: number;
  end_line?: number;
  severity: Severity;
  category: string;
  claim: string;
  evidence: string;
  suggested_fix?: string;
}

export interface FindingsDocument {
  summary: string;
  findings: Finding[];
}

export interface MergedFinding {
  id: string;
  file: string;
  line: number;
  end_line: number | null;
  severity: Severity;
  category: string;
  claim: string;
  evidence: string;
  suggested_fix: string | null;
  sources: Source[];
  adjudication: { verdict: Verdict; reason: string };
}

export interface MergedReviewStats {
  claude_total: number;
  codex_total: number;
  confirmed: number;
  refuted: number;
  uncertain: number;
}

export interface MergedReview {
  summary: string;
  findings: MergedFinding[];
  stats: MergedReviewStats;
}

// --- Hand-rolled schema validators ---
//
// `.github/ai-review/findings.schema.json` and `merged-review.schema.json`
// are the model-facing contract (passed as `--json-schema`/`output-schema-file`);
// these validators are the runtime enforcement and must be kept in sync with
// them by hand whenever either shape changes.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoExtraKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Invalid ${context} at ${path}: unexpected property "${key}"`);
    }
  }
}

function expectString(value: unknown, path: string, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${context} at ${path}: expected a string, got ${typeof value}`);
  }
  return value;
}

function expectInteger(value: unknown, path: string, context: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `Invalid ${context} at ${path}: expected an integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function expectOptionalString(value: unknown, path: string, context: string): string | undefined {
  return value === undefined ? undefined : expectString(value, path, context);
}

function expectOptionalInteger(value: unknown, path: string, context: string): number | undefined {
  return value === undefined ? undefined : expectInteger(value, path, context);
}

function expectNullableString(value: unknown, path: string, context: string): string | null {
  return value === null ? null : expectString(value, path, context);
}

function expectNullableInteger(value: unknown, path: string, context: string): number | null {
  return value === null ? null : expectInteger(value, path, context);
}

function expectSeverity(value: unknown, path: string, context: string): Severity {
  const str = expectString(value, path, context);
  if (str !== "critical" && str !== "major" && str !== "minor" && str !== "nit") {
    throw new Error(
      `Invalid ${context} at ${path}: severity must be one of critical, major, minor, nit, got "${str}"`,
    );
  }
  return str;
}

function expectVerdict(value: unknown, path: string, context: string): Verdict {
  const str = expectString(value, path, context);
  if (str !== "confirmed" && str !== "refuted" && str !== "uncertain") {
    throw new Error(
      `Invalid ${context} at ${path}: verdict must be one of confirmed, refuted, uncertain, got "${str}"`,
    );
  }
  return str;
}

function expectSource(value: unknown, path: string, context: string): Source {
  const str = expectString(value, path, context);
  if (str !== "claude" && str !== "codex") {
    throw new Error(
      `Invalid ${context} at ${path}: source must be "claude" or "codex", got "${str}"`,
    );
  }
  return str;
}

function expectSources(value: unknown, path: string, context: string): Source[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${context} at ${path}: expected an array`);
  }
  return value.map((item, index) => expectSource(item, `${path}[${index}]`, context));
}

const CATEGORY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function expectCategory(value: unknown, path: string, context: string): string {
  const str = expectString(value, path, context);
  if (!CATEGORY_PATTERN.test(str)) {
    throw new Error(`Invalid ${context} at ${path}: category must be kebab-case, got "${str}"`);
  }
  return str;
}

const FINDING_KEYS = [
  "id",
  "file",
  "line",
  "end_line",
  "severity",
  "category",
  "claim",
  "evidence",
  "suggested_fix",
];

function parseFinding(value: unknown, path: string): Finding {
  if (!isRecord(value)) {
    throw new Error(`Invalid findings document at ${path}: expected an object`);
  }
  assertNoExtraKeys(value, FINDING_KEYS, "findings document", path);
  const finding: Finding = {
    id: expectString(value.id, `${path}.id`, "findings document"),
    file: expectString(value.file, `${path}.file`, "findings document"),
    line: expectInteger(value.line, `${path}.line`, "findings document"),
    severity: expectSeverity(value.severity, `${path}.severity`, "findings document"),
    category: expectCategory(value.category, `${path}.category`, "findings document"),
    claim: expectString(value.claim, `${path}.claim`, "findings document"),
    evidence: expectString(value.evidence, `${path}.evidence`, "findings document"),
  };
  const endLine = expectOptionalInteger(value.end_line, `${path}.end_line`, "findings document");
  if (endLine !== undefined) {
    finding.end_line = endLine;
  }
  const suggestedFix = expectOptionalString(
    value.suggested_fix,
    `${path}.suggested_fix`,
    "findings document",
  );
  if (suggestedFix !== undefined) {
    finding.suggested_fix = suggestedFix;
  }
  return finding;
}

function parseFindingsDocument(value: unknown): FindingsDocument {
  if (!isRecord(value)) {
    throw new Error(`Invalid findings document: expected an object, got ${typeof value}`);
  }
  assertNoExtraKeys(value, ["summary", "findings"], "findings document", "$");
  const summary = expectString(value.summary, "$.summary", "findings document");
  if (!Array.isArray(value.findings)) {
    throw new Error(`Invalid findings document at $.findings: expected an array`);
  }
  const findings = value.findings.map((item, index) => parseFinding(item, `$.findings[${index}]`));
  return { summary, findings };
}

/** Validates `value` against the Claude findings shape, throwing a descriptive error on mismatch. */
export function assertFindings(value: unknown): asserts value is FindingsDocument {
  parseFindingsDocument(value);
}

const MERGED_FINDING_KEYS = [
  "id",
  "file",
  "line",
  "end_line",
  "severity",
  "category",
  "claim",
  "evidence",
  "suggested_fix",
  "sources",
  "adjudication",
];

function parseAdjudication(value: unknown, path: string): { verdict: Verdict; reason: string } {
  if (!isRecord(value)) {
    throw new Error(`Invalid merged review at ${path}: expected an object`);
  }
  assertNoExtraKeys(value, ["verdict", "reason"], "merged review", path);
  return {
    verdict: expectVerdict(value.verdict, `${path}.verdict`, "merged review"),
    reason: expectString(value.reason, `${path}.reason`, "merged review"),
  };
}

function parseMergedFinding(value: unknown, path: string): MergedFinding {
  if (!isRecord(value)) {
    throw new Error(`Invalid merged review at ${path}: expected an object`);
  }
  assertNoExtraKeys(value, MERGED_FINDING_KEYS, "merged review", path);
  return {
    id: expectString(value.id, `${path}.id`, "merged review"),
    file: expectString(value.file, `${path}.file`, "merged review"),
    line: expectInteger(value.line, `${path}.line`, "merged review"),
    end_line: expectNullableInteger(value.end_line, `${path}.end_line`, "merged review"),
    severity: expectSeverity(value.severity, `${path}.severity`, "merged review"),
    category: expectCategory(value.category, `${path}.category`, "merged review"),
    claim: expectString(value.claim, `${path}.claim`, "merged review"),
    evidence: expectString(value.evidence, `${path}.evidence`, "merged review"),
    suggested_fix: expectNullableString(
      value.suggested_fix,
      `${path}.suggested_fix`,
      "merged review",
    ),
    sources: expectSources(value.sources, `${path}.sources`, "merged review"),
    adjudication: parseAdjudication(value.adjudication, `${path}.adjudication`),
  };
}

function parseStats(value: unknown, path: string): MergedReviewStats {
  if (!isRecord(value)) {
    throw new Error(`Invalid merged review at ${path}: expected an object`);
  }
  assertNoExtraKeys(
    value,
    ["claude_total", "codex_total", "confirmed", "refuted", "uncertain"],
    "merged review",
    path,
  );
  return {
    claude_total: expectInteger(value.claude_total, `${path}.claude_total`, "merged review"),
    codex_total: expectInteger(value.codex_total, `${path}.codex_total`, "merged review"),
    confirmed: expectInteger(value.confirmed, `${path}.confirmed`, "merged review"),
    refuted: expectInteger(value.refuted, `${path}.refuted`, "merged review"),
    uncertain: expectInteger(value.uncertain, `${path}.uncertain`, "merged review"),
  };
}

function parseMergedReview(value: unknown): MergedReview {
  if (!isRecord(value)) {
    throw new Error(`Invalid merged review: expected an object, got ${typeof value}`);
  }
  assertNoExtraKeys(value, ["summary", "findings", "stats"], "merged review", "$");
  const summary = expectString(value.summary, "$.summary", "merged review");
  if (!Array.isArray(value.findings)) {
    throw new Error(`Invalid merged review at $.findings: expected an array`);
  }
  const findings = value.findings.map((item, index) =>
    parseMergedFinding(item, `$.findings[${index}]`),
  );
  const stats = parseStats(value.stats, "$.stats");
  return { summary, findings, stats };
}

/** Validates `value` against the Codex merged-review shape, throwing a descriptive error on mismatch. */
export function assertMergedReview(value: unknown): asserts value is MergedReview {
  parseMergedReview(value);
}

// --- Diff anchoring ---

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const NEW_FILE_HEADER = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/;

function addAnchor(anchors: Map<string, Set<number>>, file: string, line: number): void {
  let lines = anchors.get(file);
  if (!lines) {
    lines = new Set();
    anchors.set(file, lines);
  }
  lines.add(line);
}

/**
 * Parses a unified diff into, for each file, the set of new-side (RIGHT) line
 * numbers present in the diff — i.e. the lines a PR review comment can
 * anchor to. Context and `+` lines advance the RIGHT counter and are
 * anchorable; `-` lines don't exist on the new side and are skipped.
 */
export function parseDiffAnchors(diff: string): Map<string, Set<number>> {
  const anchors = new Map<string, Set<number>>();
  let currentFile: string | undefined;
  let rightLine = 0;

  for (const line of diff.split("\n")) {
    const fileMatch = NEW_FILE_HEADER.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      rightLine = Number(hunkMatch[1]);
      continue;
    }
    if (currentFile === undefined) {
      continue;
    }
    if (line.startsWith("+") || line.startsWith(" ")) {
      addAnchor(anchors, currentFile, rightLine);
      rightLine++;
    }
    // `-` lines don't exist on the new side and don't advance rightLine;
    // any other line (diff --git, index, ---, "\ No newline...") is metadata.
  }

  return anchors;
}

function isAnchorable(anchors: Map<string, Set<number>>, file: string, line: number): boolean {
  return anchors.get(file)?.has(line) ?? false;
}

// --- Findings partitioning and rendering ---

export interface PartitionedFindings {
  /** Confirmed/uncertain findings whose start line lands on a diff hunk; posted as inline comments. */
  anchorable: MergedFinding[];
  /** Confirmed/uncertain findings outside the diff; posted in the review body only. */
  nonAnchorable: MergedFinding[];
  /** Refuted findings; never posted as comments, only listed for transparency. */
  refuted: MergedFinding[];
}

/** Splits merged findings into inline-commentable, body-only, and refuted buckets. Refuted findings are always kept, never dropped. */
export function partitionFindings(
  findings: MergedFinding[],
  anchors: Map<string, Set<number>>,
): PartitionedFindings {
  const anchorable: MergedFinding[] = [];
  const nonAnchorable: MergedFinding[] = [];
  const refuted: MergedFinding[] = [];

  for (const finding of findings) {
    if (finding.adjudication.verdict === "refuted") {
      refuted.push(finding);
    } else if (isAnchorable(anchors, finding.file, finding.line)) {
      anchorable.push(finding);
    } else {
      nonAnchorable.push(finding);
    }
  }

  return { anchorable, nonAnchorable, refuted };
}

const SEVERITY_BADGES: Record<Severity, string> = {
  critical: "🔴 CRITICAL",
  major: "🟠 MAJOR",
  minor: "🟡 MINOR",
  nit: "⚪ NIT",
};

const SEVERITY_ORDER: readonly Severity[] = ["critical", "major", "minor", "nit"];

function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** Renders the body of a single inline review comment for one finding. */
export function renderInlineComment(finding: MergedFinding): string {
  const lines = [
    `**${SEVERITY_BADGES[finding.severity]}** · \`${finding.category}\` · _source: ${finding.sources.join("+")}_`,
    "",
    finding.claim,
    "",
    `**Evidence:** ${finding.evidence}`,
  ];
  if (finding.suggested_fix !== null) {
    lines.push("", `**Suggested fix:** ${finding.suggested_fix}`);
  }
  if (finding.adjudication.verdict === "uncertain") {
    lines.push("", `**Adjudication (uncertain):** ${finding.adjudication.reason}`);
  }
  return lines.join("\n");
}

export interface ReviewFooterInfo {
  trigger: Trigger;
  runUrl: string;
}

/** Renders the full review body: summary, findings table, out-of-diff section, refuted details, stats, and footer. */
export function renderReviewBody(
  review: MergedReview,
  partitioned: PartitionedFindings,
  footer: ReviewFooterInfo,
): string {
  const posted = [...partitioned.anchorable, ...partitioned.nonAnchorable].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  );

  const sections: string[] = [`## 🤖 AI Review\n\n${review.summary}`];

  if (posted.length > 0) {
    const rows = posted.map(
      (finding) =>
        `| ${SEVERITY_BADGES[finding.severity]} | \`${finding.file}:${finding.line}\` | \`${finding.category}\` | ` +
        `${finding.sources.join("+")} | ${finding.claim} |`,
    );
    sections.push(
      [
        "### Findings",
        "",
        "| Severity | Location | Category | Sources | Claim |",
        "| --- | --- | --- | --- | --- |",
        ...rows,
      ].join("\n"),
    );
  } else {
    sections.push("### Findings\n\nNo issues found.");
  }

  if (partitioned.nonAnchorable.length > 0) {
    const items = partitioned.nonAnchorable.map(
      (finding) =>
        `- **${SEVERITY_BADGES[finding.severity]}** \`${finding.file}:${finding.line}\` — ${finding.claim}`,
    );
    sections.push(["### Findings outside the diff", "", ...items].join("\n"));
  }

  if (partitioned.refuted.length > 0) {
    const items = partitioned.refuted.map(
      (finding) =>
        `- \`${finding.file}:${finding.line}\` (${finding.category}): ${finding.claim}\n  **Refuted:** ${finding.adjudication.reason}`,
    );
    sections.push(
      [
        "<details>",
        "<summary>Refuted findings (kept for transparency, not posted as review comments)</summary>",
        "",
        ...items,
        "",
        "</details>",
      ].join("\n"),
    );
  }

  sections.push(
    [
      "### Stats",
      "",
      `Claude findings: ${review.stats.claude_total} · Codex findings: ${review.stats.codex_total} · ` +
        `Confirmed: ${review.stats.confirmed} · Refuted: ${review.stats.refuted} · Uncertain: ${review.stats.uncertain}`,
    ].join("\n"),
  );

  sections.push(
    [
      "---",
      `Models: ${MODELS_FOOTER} · Trigger: \`${footer.trigger}\` · [Workflow run](${footer.runUrl})`,
      "",
      "This review runs once per PR. A maintainer can request another with a `/ai-review` comment.",
      "",
      AI_REVIEW_MARKER,
    ].join("\n"),
  );

  return sections.join("\n\n");
}

/** Renders the notice posted instead of a review when the diff exceeds the size guard. */
export function renderTooLargeNotice(stats: {
  additions: number;
  deletions: number;
  changedFiles: number;
}): string {
  return [
    "## 🤖 AI Review",
    "",
    `This PR is too large for a full AI review ` +
      `(+${stats.additions}/-${stats.deletions} lines across ${stats.changedFiles} files).`,
    "",
    "A maintainer can request a review anyway with a `/ai-review` comment.",
    "",
    AI_REVIEW_MARKER,
  ].join("\n");
}

export interface InlineReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export interface ReviewPayload {
  event: "COMMENT";
  body: string;
  comments: InlineReviewComment[];
}

function buildInlineComment(
  finding: MergedFinding,
  anchors: Map<string, Set<number>>,
): InlineReviewComment {
  const body = renderInlineComment(finding);
  if (finding.end_line !== null && isAnchorable(anchors, finding.file, finding.end_line)) {
    return {
      path: finding.file,
      start_line: finding.line,
      start_side: "RIGHT",
      line: finding.end_line,
      side: "RIGHT",
      body,
    };
  }
  return { path: finding.file, line: finding.line, side: "RIGHT", body };
}

/**
 * Builds the single review payload for `POST /pulls/{n}/reviews`. `event` is
 * always `COMMENT` — this pipeline is advisory only, never
 * `REQUEST_CHANGES`/`APPROVE`, since it must not block merges on its own.
 */
export function buildReviewPayload(
  review: MergedReview,
  anchors: Map<string, Set<number>>,
  footer: ReviewFooterInfo,
): ReviewPayload {
  const partitioned = partitionFindings(review.findings, anchors);
  const comments = partitioned.anchorable.map((finding) => buildInlineComment(finding, anchors));
  const body = renderReviewBody(review, partitioned, footer);
  return { event: "COMMENT", body, comments };
}

/** Folds every inline comment into the review body, for the 422-retry path when GitHub rejects an anchor. */
export function foldInlineCommentsIntoBody(payload: ReviewPayload): ReviewPayload {
  if (payload.comments.length === 0) {
    return payload;
  }
  const folded = [
    "### Inline comments (GitHub rejected one or more anchors; folded into the body)",
    "",
    ...payload.comments.map(
      (comment) => `**\`${comment.path}:${comment.line}\`**\n\n${comment.body}`,
    ),
  ].join("\n\n");
  return { ...payload, comments: [], body: `${payload.body}\n\n${folded}` };
}

/** Whether a previously-posted review/comment body has already been wrapped as superseded. */
export function isSuperseded(body: string): boolean {
  return body.includes(SUPERSEDED_SUMMARY);
}

/** Wraps a prior AI review/comment body in a collapsed `<details>` marking it superseded. */
export function supersededBody(oldBody: string): string {
  return [
    "<details>",
    `<summary>${SUPERSEDED_SUMMARY}</summary>`,
    "",
    oldBody,
    "",
    "</details>",
  ].join("\n");
}

// --- Injected GitHub I/O ---

export interface PrStats {
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface MarkedEntry {
  id: number;
  body: string;
  authorLogin: string;
}

export interface ReviewIo {
  fetchPrDiff: (prNumber: number) => Promise<string>;
  fetchPrStats: (prNumber: number) => Promise<PrStats>;
  listReviews: (prNumber: number) => Promise<MarkedEntry[]>;
  listIssueComments: (prNumber: number) => Promise<MarkedEntry[]>;
  updateReviewBody: (prNumber: number, reviewId: number, body: string) => Promise<void>;
  updateIssueCommentBody: (commentId: number, body: string) => Promise<void>;
  /** Posts the review; returns the response status so the caller can detect a 422 (bad anchor) and retry. */
  postReview: (prNumber: number, payload: ReviewPayload) => Promise<{ status: number }>;
  postIssueComment: (prNumber: number, body: string) => Promise<void>;
}

/** Wraps every prior AI review/comment on the PR in a superseded `<details>` block. Idempotent. */
async function supersedePriorRuns(io: ReviewIo, prNumber: number): Promise<void> {
  const [reviews, comments] = await Promise.all([
    io.listReviews(prNumber),
    io.listIssueComments(prNumber),
  ]);

  for (const review of reviews) {
    if (
      review.authorLogin !== WORKFLOW_BOT_LOGIN ||
      !review.body.includes(AI_REVIEW_MARKER) ||
      isSuperseded(review.body)
    ) {
      continue;
    }
    await io.updateReviewBody(prNumber, review.id, supersededBody(review.body));
  }

  for (const comment of comments) {
    if (
      comment.authorLogin !== WORKFLOW_BOT_LOGIN ||
      !comment.body.includes(AI_REVIEW_MARKER) ||
      isSuperseded(comment.body)
    ) {
      continue;
    }
    await io.updateIssueCommentBody(comment.id, supersededBody(comment.body));
  }
}

export async function postTooLargeNotice(io: ReviewIo, prNumber: number): Promise<void> {
  const stats = await io.fetchPrStats(prNumber);
  await io.postIssueComment(prNumber, renderTooLargeNotice(stats));
}

export async function postConsolidatedReview(
  io: ReviewIo,
  prNumber: number,
  review: MergedReview,
  footer: ReviewFooterInfo,
): Promise<void> {
  const diff = await io.fetchPrDiff(prNumber);
  const anchors = parseDiffAnchors(diff);

  await supersedePriorRuns(io, prNumber);

  const payload = buildReviewPayload(review, anchors, footer);
  const result = await io.postReview(prNumber, payload);
  if (result.status === 422) {
    console.warn(
      "Review POST rejected an inline anchor (422); retrying once with comments folded into the body.",
    );
    await io.postReview(prNumber, foldInlineCommentsIntoBody(payload));
  }
}

// --- Real GitHub I/O (only runs when executed directly) ---

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function githubFetch(
  url: string,
  token: string,
  init: Omit<RequestInit, "headers"> = {},
  accept = "application/vnd.github+json",
  /** Non-OK statuses to return to the caller instead of throwing on. */
  allowStatuses: readonly number[] = [],
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok && !allowStatuses.includes(response.status)) {
    const body = await response.text();
    throw new Error(`GitHub request failed (${response.status}) for ${url}: ${body}`);
  }
  return response;
}

interface RestPullRequest {
  additions: number;
  deletions: number;
  changed_files: number;
}

interface RestReview {
  id: number;
  body: string | null;
  user: { login: string } | null;
}

interface RestIssueComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
}

async function fetchPrDiff(token: string, base: string, prNumber: number): Promise<string> {
  const response = await githubFetch(
    `${base}/pulls/${prNumber}`,
    token,
    {},
    "application/vnd.github.v3.diff",
  );
  return response.text();
}

async function fetchPrStats(token: string, base: string, prNumber: number): Promise<PrStats> {
  const response = await githubFetch(`${base}/pulls/${prNumber}`, token);
  const pr: RestPullRequest = await response.json();
  return { additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changed_files };
}

async function listAllPages<T>(token: string, url: string): Promise<T[]> {
  const entries: T[] = [];
  for (let page = 1; ; page++) {
    const separator = url.includes("?") ? "&" : "?";
    const response = await githubFetch(`${url}${separator}per_page=100&page=${page}`, token);
    const batch: T[] = await response.json();
    entries.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return entries;
}

async function listReviews(token: string, base: string, prNumber: number): Promise<MarkedEntry[]> {
  const reviews = await listAllPages<RestReview>(token, `${base}/pulls/${prNumber}/reviews`);
  return reviews.map((review) => ({
    id: review.id,
    body: review.body ?? "",
    authorLogin: review.user?.login ?? "",
  }));
}

async function listIssueComments(
  token: string,
  base: string,
  prNumber: number,
): Promise<MarkedEntry[]> {
  const comments = await listAllPages<RestIssueComment>(
    token,
    `${base}/issues/${prNumber}/comments`,
  );
  return comments.map((comment) => ({
    id: comment.id,
    body: comment.body ?? "",
    authorLogin: comment.user?.login ?? "",
  }));
}

async function updateReviewBody(
  token: string,
  base: string,
  prNumber: number,
  reviewId: number,
  body: string,
): Promise<void> {
  await githubFetch(`${base}/pulls/${prNumber}/reviews/${reviewId}`, token, {
    method: "PUT",
    body: JSON.stringify({ body }),
  });
}

async function updateIssueCommentBody(
  token: string,
  base: string,
  commentId: number,
  body: string,
): Promise<void> {
  await githubFetch(`${base}/issues/comments/${commentId}`, token, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}

async function postReview(
  token: string,
  base: string,
  prNumber: number,
  payload: ReviewPayload,
): Promise<{ status: number }> {
  const response = await githubFetch(
    `${base}/pulls/${prNumber}/reviews`,
    token,
    { method: "POST", body: JSON.stringify(payload) },
    "application/vnd.github+json",
    [422],
  );
  return { status: response.status };
}

async function postIssueComment(
  token: string,
  base: string,
  prNumber: number,
  body: string,
): Promise<void> {
  await githubFetch(`${base}/issues/${prNumber}/comments`, token, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

function makeGithubReviewIo(token: string, base: string): ReviewIo {
  return {
    fetchPrDiff: (prNumber) => fetchPrDiff(token, base, prNumber),
    fetchPrStats: (prNumber) => fetchPrStats(token, base, prNumber),
    listReviews: (prNumber) => listReviews(token, base, prNumber),
    listIssueComments: (prNumber) => listIssueComments(token, base, prNumber),
    updateReviewBody: (prNumber, reviewId, body) =>
      updateReviewBody(token, base, prNumber, reviewId, body),
    updateIssueCommentBody: (commentId, body) =>
      updateIssueCommentBody(token, base, commentId, body),
    postReview: (prNumber, payload) => postReview(token, base, prNumber, payload),
    postIssueComment: (prNumber, body) => postIssueComment(token, base, prNumber, body),
  };
}

function parseMode(value: string): Mode {
  if (value !== "review" && value !== "too-large") {
    throw new Error(`Invalid MODE "${value}"; expected "review" or "too-large".`);
  }
  return value;
}

function parseTrigger(value: string): Trigger {
  if (value !== "auto" && value !== "manual") {
    throw new Error(`Invalid TRIGGER "${value}"; expected "auto" or "manual".`);
  }
  return value;
}

async function runPost(): Promise<void> {
  const token = requireEnv("GITHUB_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const [owner, repo] = repository.split("/");
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const io = makeGithubReviewIo(token, base);

  const prNumber = Number(requireEnv("PR_NUMBER"));
  const mode = parseMode(requireEnv("MODE"));

  if (mode === "too-large") {
    await postTooLargeNotice(io, prNumber);
    console.log(`Posted "too large" notice on PR #${prNumber}.`);
    return;
  }

  const trigger = parseTrigger(requireEnv("TRIGGER"));
  const runUrl = requireEnv("RUN_URL");
  const mergedReviewPath = requireEnv("MERGED_REVIEW_PATH");

  const raw: unknown = JSON.parse(await Bun.file(mergedReviewPath).text());
  assertMergedReview(raw);

  await postConsolidatedReview(io, prNumber, raw, { trigger, runUrl });
  console.log(`Posted AI review on PR #${prNumber} (${raw.findings.length} finding(s)).`);
}

function requireArg(value: string | undefined, command: string): string {
  if (!value) {
    throw new Error(`Usage: bun .github/scripts/ai-review/post-review.ts ${command} <path>`);
  }
  return value;
}

async function main(): Promise<void> {
  const [, , command, arg] = process.argv;

  switch (command) {
    case "validate-findings": {
      const path = requireArg(arg, "validate-findings");
      const raw: unknown = JSON.parse(await Bun.file(path).text());
      assertFindings(raw);
      console.log(`OK: ${path} matches the findings schema (${raw.findings.length} finding(s)).`);
      return;
    }
    case "validate-merged": {
      const path = requireArg(arg, "validate-merged");
      const raw: unknown = JSON.parse(await Bun.file(path).text());
      assertMergedReview(raw);
      console.log(
        `OK: ${path} matches the merged review schema (${raw.findings.length} finding(s)).`,
      );
      return;
    }
    case "post":
      await runPost();
      return;
    default:
      throw new Error(
        `Unknown command: ${command ?? "<none>"}. Expected one of: validate-findings, validate-merged, post.`,
      );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
