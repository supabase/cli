/**
 * AI review poster: validates the structured findings both model passes
 * produce, and posts the ONE consolidated PR review the pipeline is allowed
 * to post per run.
 *
 * Four subcommands, dispatched from `argv`:
 *   - `validate-findings <path>` — checks a Claude findings JSON file against
 *     the shape `.github/ai-review/findings.schema.json` describes. The
 *     `--json-schema` flag passed to `claude` is a hint to the model, not a
 *     runtime guarantee, so the CI step re-checks the extracted output here
 *     before it is trusted.
 *   - `validate-merged <path>` — same idea for the Codex-adjudicated merged
 *     review, against `.github/ai-review/merged-review.schema.json`.
 *   - `redact <path>` — reads a JSON file, deep-walks every string value
 *     through `redactSecrets`, and writes it back in place. Run on every
 *     model-output JSON file before it's uploaded as a (public-repo)
 *     artifact, so a prompt-injected `Read` of a secret-bearing path can't
 *     smuggle a credential out through the artifact even though the posted
 *     review is already scrubbed at render time.
 *   - `post` — posts the consolidated review, THEN best-effort supersedes any
 *     prior AI review on the PR (the marker/dedup guard in `resolve.ts` should
 *     normally prevent a second run, but `/ai-review` lets a maintainer force
 *     one; posting before superseding, and treating the supersede as
 *     best-effort, means a cosmetic supersede failure can never cost the real
 *     review).
 *
 * `parseDiffAnchors`, `partitionFindings`, `renderReviewBody`,
 * `renderInlineComment`, `buildReviewPayload`, `foldInlineCommentsIntoBody`,
 * `supersededBody`, `isSuperseded`, `sanitizeFilePath`, and `redactSecrets`
 * are pure and exported for tests. `postConsolidatedReview` is the I/O
 * orchestration function for the `post` subcommand; it's exported so a test can drive it against
 * an injected `ReviewIo` fake without the network, the same way
 * `resolveDecision` is tested in `resolve.ts`. `main()` wires up the real
 * GitHub I/O and argv dispatch.
 *
 * Run in CI as: `bun .github/scripts/ai-review/post-review.ts <command>`.
 */

export const AI_REVIEW_MARKER = "<!-- supabase-ai-review -->";
const SUPERSEDED_SUMMARY = "Superseded by a newer AI review";
/** Hidden marker `isSuperseded` looks for. Kept out of the human-readable
 * `SUPERSEDED_SUMMARY` text and stripped by `sanitizeModelText` so a model
 * can't forge or evade a supersede by echoing the visible text into a
 * `claim`/`summary` field. */
const SUPERSEDED_MARKER = "<!-- supabase-ai-review:superseded -->";
const WORKFLOW_BOT_LOGIN = "github-actions[bot]";
const GITHUB_REVIEW_BODY_MAX = 65536;

// --- Shared types (mirror the two schema files by hand; keep in sync) ---

export type Severity = "critical" | "major" | "minor" | "nit";
export type Verdict = "confirmed" | "refuted" | "uncertain";
export type Source = "claude" | "codex";
export type Trigger = "auto" | "manual";

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
}

/** Verdict counts computed locally from the merged findings, never taken from
 * the model — the README promises a deterministic script decides output. */
export interface VerdictCounts {
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
  if (value.length === 0) {
    throw new Error(
      `Invalid ${context} at ${path}: expected at least one source, got an empty array`,
    );
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

/** `file` is model-controlled and rendered inside `` `code` `` spans at
 * several sites; a backtick, newline, other ASCII control char, or `<` in it
 * could break out of the span (markdown/HTML injection, mention/#ref pings)
 * or forge one of the hidden HTML-comment markers. Reject those at parse
 * time as the primary defense; `sanitizeFilePath` neutralizes the same
 * characters again at render time in case a caller ever skips validation. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this pattern
const FILE_PATH_FORBIDDEN_PATTERN = /[`<\x00-\x1f\x7f]/;

function expectFile(value: unknown, path: string, context: string): string {
  const str = expectString(value, path, context);
  // Checked before the generic char-class rejection below so a marker string
  // (which already contains a forbidden `<`) is rejected with a specific,
  // reachable message instead of always falling through to the generic one.
  if (str.includes(AI_REVIEW_MARKER) || str.includes(SUPERSEDED_MARKER)) {
    throw new Error(`Invalid ${context} at ${path}: file path contains a reserved marker string`);
  }
  if (FILE_PATH_FORBIDDEN_PATTERN.test(str)) {
    throw new Error(
      `Invalid ${context} at ${path}: file path contains a disallowed character ` +
        `(backtick, "<", or an ASCII control character)`,
    );
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
    file: expectFile(value.file, `${path}.file`, "findings document"),
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
    file: expectFile(value.file, `${path}.file`, "merged review"),
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
  assertNoExtraKeys(value, ["claude_total", "codex_total"], "merged review", path);
  return {
    claude_total: expectInteger(value.claude_total, `${path}.claude_total`, "merged review"),
    codex_total: expectInteger(value.codex_total, `${path}.codex_total`, "merged review"),
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

const DIFF_GIT_HEADER = /^diff --git /;
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

/** Git appends a literal TAB after a `---`/`+++` path that needs quoting
 * (e.g. one containing a space); strip it so the anchored path matches the
 * real repo-relative path a finding would cite. */
function stripTrailingTab(path: string): string {
  return path.endsWith("\t") ? path.slice(0, -1) : path;
}

/**
 * Parses a unified diff into, for each file, the set of new-side (RIGHT) line
 * numbers present in the diff — i.e. the lines a PR review comment can
 * anchor to. Context and `+` lines advance the RIGHT counter and are
 * anchorable; `-` lines don't exist on the new side and are skipped.
 *
 * Tracks whether we're inside a hunk so a `+++ ` file header is only ever
 * recognized between a `diff --git` boundary and that file's first `@@`
 * hunk — otherwise an added/context line whose literal content happens to
 * start with `+++ ` (a `+++`-lookalike) could hijack `currentFile`.
 */
export function parseDiffAnchors(diff: string): Map<string, Set<number>> {
  const anchors = new Map<string, Set<number>>();
  let currentFile: string | undefined;
  let rightLine = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (DIFF_GIT_HEADER.test(line)) {
      currentFile = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      const fileMatch = NEW_FILE_HEADER.exec(line);
      if (fileMatch) {
        currentFile = fileMatch[1] === undefined ? undefined : stripTrailingTab(fileMatch[1]);
        continue;
      }
    }
    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      inHunk = true;
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
    // any other line (index, ---, "\ No newline...") is metadata.
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

/** Computes verdict counts locally from the merged findings, never trusting
 * the model's own tally. */
export function computeVerdictCounts(findings: MergedFinding[]): VerdictCounts {
  const counts: VerdictCounts = { confirmed: 0, refuted: 0, uncertain: 0 };
  for (const finding of findings) {
    counts[finding.adjudication.verdict]++;
  }
  return counts;
}

const MENTION_PATTERN = /@(?=\w)/g;
const ISSUE_REF_PATTERN = /#(?=\d)/g;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

const REDACTED_SECRET = "«redacted»";

/** Credential shapes commonly seen in Anthropic/OpenAI API keys and GitHub
 * personal-access/app/OAuth/Actions tokens. Not exhaustive — this is
 * defense-in-depth alongside a dedicated, spend-capped, rotatable
 * `ANTHROPIC_API_KEY` (see the README); the dedicated key is the real
 * containment. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // OpenAI keys embed hyphenated prefixes (`sk-proj-…`, `sk-svcacct-…`,
  // `sk-admin-…`) as well as the legacy `sk-<40 alnum>` shape, so the class
  // must allow `-`/`_` — otherwise the match stops at the first hyphen and a
  // leaked project-scoped key reaches the posted review/artifact unredacted.
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  // GitHub App/OAuth/Actions tokens (gho_, ghu_, ghs_, ghr_) share this
  // prefix+length shape with `ghp_` personal access tokens.
  /gh[oprsu]_[A-Za-z0-9]{36,}/g,
];

/**
 * Replaces common credential formats with a redaction marker. Pure; composed
 * into `sanitizeModelText` below so every model-provided string rendered into
 * the posted review is scrubbed, and applied again (via the `redact`
 * subcommand) to the raw JSON artifacts before upload. Defense-in-depth
 * against a prompt-injected model `Read`-ing a secret-bearing path (e.g.
 * `/proc/self/environ`) and echoing the value back in a finding.
 */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, REDACTED_SECRET), text);
}

/** Deep-walks an arbitrary JSON value, redacting every string it contains.
 * Exported for tests; the `redact` subcommand (see `runRedact` below) is the
 * thin file-I/O wrapper around it that scrubs the raw JSON artifacts before
 * they're uploaded. */
export function redactSecretsDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = redactSecretsDeep(entry);
    }
    return result;
  }
  return value;
}

/**
 * Neutralizes a model-provided string before it's rendered into a
 * `github-actions[bot]` review: redacts secret-shaped substrings first, strips
 * HTML comments (so injected diff content can't forge the hidden
 * `AI_REVIEW_MARKER`/`SUPERSEDED_MARKER` comments), then breaks
 * `@mention`/`#123` syntax with a zero-width HTML comment so GitHub never
 * renders them as a live mention or issue reference. Pure; apply to every
 * model-provided string (`summary`, `claim`, `evidence`, `suggested_fix`,
 * `adjudication.reason`) at render time.
 */
export function sanitizeModelText(text: string): string {
  return redactSecrets(text)
    .replace(HTML_COMMENT_PATTERN, "")
    .replace(MENTION_PATTERN, "@<!---->")
    .replace(ISSUE_REF_PATTERN, "#<!---->");
}

/** Neutralizes the same characters `expectFile` rejects at parse time
 * (backtick, `<`, ASCII control chars) inside a model-provided `file` path
 * before it's rendered into a `` `code` `` span. Every finding reaching a
 * render site will already have passed `expectFile`; this is defense-in-depth
 * for any caller that renders a `MergedFinding` without going through
 * `assertMergedReview` first. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this pattern
const FILE_PATH_UNSAFE_CHARS = /[`<\x00-\x1f\x7f]/g;

export function sanitizeFilePath(file: string): string {
  return file.replace(FILE_PATH_UNSAFE_CHARS, "");
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
    sanitizeModelText(finding.claim),
    "",
    `**Evidence:** ${sanitizeModelText(finding.evidence)}`,
  ];
  if (finding.suggested_fix !== null) {
    lines.push("", `**Suggested fix:** ${sanitizeModelText(finding.suggested_fix)}`);
  }
  if (finding.adjudication.verdict === "uncertain") {
    lines.push(
      "",
      `**Adjudication (uncertain):** ${sanitizeModelText(finding.adjudication.reason)}`,
    );
  }
  return lines.join("\n");
}

export interface ReviewFooterInfo {
  trigger: Trigger;
  runUrl: string;
  /** e.g. `` `claude-fable-5` + `gpt-5.6-sol` ``. Passed in from the workflow's
   * `CLAUDE_MODEL`/`CODEX_MODEL` env vars instead of being hardcoded here, so
   * the model names have one source of truth. */
  modelsFooter: string;
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
  const verdicts = computeVerdictCounts(review.findings);

  const sections: string[] = [`## 🤖 AI Review\n\n${sanitizeModelText(review.summary)}`];

  if (posted.length > 0) {
    const rows = posted.map(
      (finding) =>
        `| ${SEVERITY_BADGES[finding.severity]} | \`${sanitizeFilePath(finding.file)}:${finding.line}\` | \`${finding.category}\` | ` +
        `${finding.sources.join("+")} | ${sanitizeModelText(finding.claim)} |`,
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
        `- **${SEVERITY_BADGES[finding.severity]}** \`${sanitizeFilePath(finding.file)}:${finding.line}\` — ${sanitizeModelText(finding.claim)}`,
    );
    sections.push(["### Findings outside the diff", "", ...items].join("\n"));
  }

  if (partitioned.refuted.length > 0) {
    const items = partitioned.refuted.map(
      (finding) =>
        `- \`${sanitizeFilePath(finding.file)}:${finding.line}\` (${finding.category}): ${sanitizeModelText(finding.claim)}\n  **Refuted:** ${sanitizeModelText(finding.adjudication.reason)}`,
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
        `Confirmed: ${verdicts.confirmed} · Refuted: ${verdicts.refuted} · Uncertain: ${verdicts.uncertain}`,
    ].join("\n"),
  );

  sections.push(
    [
      "---",
      `Models: ${footer.modelsFooter} · Trigger: \`${footer.trigger}\` · [Workflow run](${footer.runUrl})`,
      "",
      "This review runs once per PR. A maintainer can request another with a `/ai-review` comment.",
      "",
      AI_REVIEW_MARKER,
    ].join("\n"),
  );

  return sections.join("\n\n");
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
  // GitHub requires `start_line < line` for the range form; `end_line ===
  // line` is a likely model output (the schema marks `end_line` required),
  // and using the range form for it 422s the whole review POST.
  if (
    finding.end_line !== null &&
    finding.end_line > finding.line &&
    isAnchorable(anchors, finding.file, finding.end_line)
  ) {
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
  // A body-only review (many non-anchorable findings, few or no inline
  // comments) has no fold-retry path to truncate it on a 422 — truncate the
  // very first payload too, so an oversized body posts truncated instead of
  // throwing when GitHub rejects it for exceeding the review body cap.
  return { event: "COMMENT", body: truncateReviewBody(body, footer.runUrl), comments };
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
      (comment) => `**\`${sanitizeFilePath(comment.path)}:${comment.line}\`**\n\n${comment.body}`,
    ),
  ].join("\n\n");
  return { ...payload, comments: [], body: `${payload.body}\n\n${folded}` };
}

/** Truncates a review body to GitHub's 65536-char review body cap, appending
 * an explicit truncation marker + the workflow run URL. Applied to both the
 * very first payload (`buildReviewPayload`) and the folded 422-retry body
 * (every inline comment stuffed into one body), a no-op when the body is
 * already under the cap. */
export function truncateReviewBody(body: string, runUrl: string): string {
  if (body.length <= GITHUB_REVIEW_BODY_MAX) {
    return body;
  }
  const marker = `\n\n… (truncated — see workflow run: ${runUrl})`;
  return body.slice(0, GITHUB_REVIEW_BODY_MAX - marker.length) + marker;
}

/** Whether a previously-posted review/comment body has already been wrapped as superseded. */
export function isSuperseded(body: string): boolean {
  return body.includes(SUPERSEDED_MARKER);
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
    "",
    SUPERSEDED_MARKER,
  ].join("\n");
}

// --- Injected GitHub I/O ---

export interface MarkedEntry {
  id: number;
  body: string;
  authorLogin: string;
}

export interface ReviewIo {
  fetchPrDiff: (prNumber: number) => Promise<string>;
  listReviews: (prNumber: number) => Promise<MarkedEntry[]>;
  listIssueComments: (prNumber: number) => Promise<MarkedEntry[]>;
  updateReviewBody: (prNumber: number, reviewId: number, body: string) => Promise<void>;
  updateIssueCommentBody: (commentId: number, body: string) => Promise<void>;
  /** Posts the review; returns the response status so the caller can detect a
   * 422 (bad anchor) and retry, and the response body for a non-2xx status
   * so a second failure can surface GitHub's actual error instead of being
   * silently swallowed. */
  postReview: (
    prNumber: number,
    payload: ReviewPayload,
  ) => Promise<{ status: number; body?: string }>;
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

/** Best-effort wrapper around `supersedePriorRuns`: a cosmetic failure here
 * (e.g. a transient 404 on a review that was deleted mid-run) must never
 * fail the pipeline after the real review/notice has already been posted. */
async function supersedePriorRunsBestEffort(io: ReviewIo, prNumber: number): Promise<void> {
  try {
    await supersedePriorRuns(io, prNumber);
  } catch (error) {
    console.warn(`Could not supersede prior AI review runs on PR #${prNumber}: ${String(error)}`);
  }
}

export async function postConsolidatedReview(
  io: ReviewIo,
  prNumber: number,
  review: MergedReview,
  footer: ReviewFooterInfo,
): Promise<void> {
  const diff = await io.fetchPrDiff(prNumber);
  const anchors = parseDiffAnchors(diff);
  const payload = buildReviewPayload(review, anchors, footer);

  const result = await io.postReview(prNumber, payload);
  if (result.status === 422 && payload.comments.length > 0) {
    console.warn(
      "Review POST rejected an inline anchor (422); retrying once with comments folded into the body.",
    );
    const folded = foldInlineCommentsIntoBody(payload);
    const retryResult = await io.postReview(prNumber, {
      ...folded,
      body: truncateReviewBody(folded.body, footer.runUrl),
    });
    if (retryResult.status < 200 || retryResult.status >= 300) {
      throw new Error(
        `Review POST failed even after folding inline comments into the body ` +
          `(status ${retryResult.status}): ${retryResult.body ?? "<no response body>"}`,
      );
    }
  } else if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `Review POST failed (status ${result.status}): ${result.body ?? "<no response body>"}`,
    );
  }

  await supersedePriorRunsBestEffort(io, prNumber);
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

function isRecordEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The validated boundary between `Response.json()` (typed `Promise<unknown>`
 * under `@tsconfig/bun`) and this file's typed shapes: `assert` narrows the
 * parsed value to `T` before any caller reads a field off it.
 */
async function githubJson<T>(
  response: Response,
  assert: (value: unknown) => asserts value is T,
): Promise<T> {
  const value: unknown = await response.json();
  assert(value);
  return value;
}

function isIdBodyUserEntry(
  value: unknown,
): value is { id: number; body: string | null; user: { login: string } | null } {
  return (
    isRecordEntry(value) &&
    typeof value.id === "number" &&
    (value.body === null || typeof value.body === "string") &&
    (value.user === null || (isRecordEntry(value.user) && typeof value.user.login === "string"))
  );
}

function assertRestReviews(value: unknown): asserts value is RestReview[] {
  if (!Array.isArray(value) || !value.every(isIdBodyUserEntry)) {
    throw new Error(
      "Malformed GitHub reviews response: expected an array of {id, body, user} entries.",
    );
  }
}

function assertRestIssueComments(value: unknown): asserts value is RestIssueComment[] {
  if (!Array.isArray(value) || !value.every(isIdBodyUserEntry)) {
    throw new Error(
      "Malformed GitHub issue comments response: expected an array of {id, body, user} entries.",
    );
  }
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

async function listAllPages<T>(
  token: string,
  url: string,
  assertBatch: (value: unknown) => asserts value is T[],
): Promise<T[]> {
  const entries: T[] = [];
  for (let page = 1; ; page++) {
    const separator = url.includes("?") ? "&" : "?";
    const response = await githubFetch(`${url}${separator}per_page=100&page=${page}`, token);
    const batch = await githubJson(response, assertBatch);
    entries.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return entries;
}

async function listReviews(token: string, base: string, prNumber: number): Promise<MarkedEntry[]> {
  const reviews = await listAllPages<RestReview>(
    token,
    `${base}/pulls/${prNumber}/reviews`,
    assertRestReviews,
  );
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
    assertRestIssueComments,
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
): Promise<{ status: number; body?: string }> {
  const response = await githubFetch(
    `${base}/pulls/${prNumber}/reviews`,
    token,
    { method: "POST", body: JSON.stringify(payload) },
    "application/vnd.github+json",
    [422],
  );
  // `githubFetch` only returns without throwing for a 2xx or the allowed
  // 422; read the body for the 422 case too so a second failed retry can
  // surface it instead of discarding it.
  if (response.status === 422) {
    return { status: response.status, body: await response.text() };
  }
  return { status: response.status };
}

function makeGithubReviewIo(token: string, base: string): ReviewIo {
  return {
    fetchPrDiff: (prNumber) => fetchPrDiff(token, base, prNumber),
    listReviews: (prNumber) => listReviews(token, base, prNumber),
    listIssueComments: (prNumber) => listIssueComments(token, base, prNumber),
    updateReviewBody: (prNumber, reviewId, body) =>
      updateReviewBody(token, base, prNumber, reviewId, body),
    updateIssueCommentBody: (commentId, body) =>
      updateIssueCommentBody(token, base, commentId, body),
    postReview: (prNumber, payload) => postReview(token, base, prNumber, payload),
  };
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
  const trigger = parseTrigger(requireEnv("TRIGGER"));
  const runUrl = requireEnv("RUN_URL");
  const mergedReviewPath = requireEnv("MERGED_REVIEW_PATH");
  // Sourced from the workflow's top-level `env:` block (the same values fed
  // to the `claude`/`codex-action` invocations), not hardcoded here, so the
  // model names have one source of truth.
  const claudeModel = requireEnv("CLAUDE_MODEL");
  const codexModel = requireEnv("CODEX_MODEL");

  const raw: unknown = JSON.parse(await Bun.file(mergedReviewPath).text());
  assertMergedReview(raw);

  await postConsolidatedReview(io, prNumber, raw, {
    trigger,
    runUrl,
    modelsFooter: `\`${claudeModel}\` + \`${codexModel}\``,
  });
  console.log(`Posted AI review on PR #${prNumber} (${raw.findings.length} finding(s)).`);
}

/** Reads a JSON file, redacts every string value in place through
 * `redactSecretsDeep`, and writes it back — the `redact` subcommand's I/O. */
async function runRedact(path: string): Promise<void> {
  const raw: unknown = JSON.parse(await Bun.file(path).text());
  const redacted = redactSecretsDeep(raw);
  await Bun.write(path, `${JSON.stringify(redacted, null, 2)}\n`);
  console.log(`OK: redacted secrets in ${path}.`);
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
    case "redact": {
      const path = requireArg(arg, "redact");
      await runRedact(path);
      return;
    }
    case "post":
      await runPost();
      return;
    default:
      throw new Error(
        `Unknown command: ${command ?? "<none>"}. Expected one of: validate-findings, validate-merged, redact, post.`,
      );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
