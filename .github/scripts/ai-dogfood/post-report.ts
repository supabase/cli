/**
 * Functional dogfood report: validate Codex JSON, redact, post one PR comment,
 * or fetch the latest bot-authored report for `/ai-review` to consume.
 *
 * Subcommands:
 *   - `validate-report <path>` — runtime check against report.schema.json.
 *   - `redact <path>` — deep-walk JSON through `redactSecretsDeep`.
 *   - `stub` — write a no-go crash stub to `REPORT_PATH`.
 *   - `post` — post one issue comment (never a review).
 *   - `fetch` — write the latest dogfood comment body to `DOGFOOD_REPORT_PATH`
 *     (empty file if none) and `verdict` to `$GITHUB_OUTPUT` when present.
 *     When `HEAD_SHA` is set, skip reports whose CLI HEAD does not match.
 *
 * Run in CI as: `bun .github/scripts/ai-dogfood/post-report.ts <command>`.
 */

import { appendFileSync } from "node:fs";

import { redactSecretsDeep, sanitizeModelText } from "../ai-review/post-review.ts";

export const AI_DOGFOOD_MARKER = "<!-- supabase-ai-dogfood -->";

const WORKFLOW_BOT_LOGIN = "github-actions[bot]";

export type DogfoodVerdict = "go" | "conditional" | "no-go";
export type JourneyResult = "pass" | "fail" | "skip";

export interface DogfoodJourney {
  id: string;
  commands: string[];
  result: JourneyResult;
  notes: string;
}

export interface DogfoodReport {
  verdict: DogfoodVerdict;
  summary: string;
  head_sha: string;
  journeys: DogfoodJourney[];
  blockers: string[];
  cleanup: { projects_deleted: string[] };
}

export interface DogfoodCommentFooter {
  runUrl: string;
  model: string;
}

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

function expectStringArray(value: unknown, path: string, context: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Invalid ${context} at ${path}: expected an array of strings`);
  }
  return value;
}

function expectVerdict(value: unknown, path: string, context: string): DogfoodVerdict {
  const str = expectString(value, path, context);
  if (str !== "go" && str !== "conditional" && str !== "no-go") {
    throw new Error(
      `Invalid ${context} at ${path}: verdict must be one of go, conditional, no-go, got "${str}"`,
    );
  }
  return str;
}

function expectJourneyResult(value: unknown, path: string, context: string): JourneyResult {
  const str = expectString(value, path, context);
  if (str !== "pass" && str !== "fail" && str !== "skip") {
    throw new Error(
      `Invalid ${context} at ${path}: result must be one of pass, fail, skip, got "${str}"`,
    );
  }
  return str;
}

const JOURNEY_KEYS = ["id", "commands", "result", "notes"];
const REPORT_KEYS = ["verdict", "summary", "head_sha", "journeys", "blockers", "cleanup"];
const CLEANUP_KEYS = ["projects_deleted"];

function parseJourney(value: unknown, path: string): DogfoodJourney {
  if (!isRecord(value)) {
    throw new Error(`Invalid dogfood report at ${path}: expected an object`);
  }
  assertNoExtraKeys(value, JOURNEY_KEYS, "dogfood report", path);
  return {
    id: expectString(value.id, `${path}.id`, "dogfood report"),
    commands: expectStringArray(value.commands, `${path}.commands`, "dogfood report"),
    result: expectJourneyResult(value.result, `${path}.result`, "dogfood report"),
    notes: expectString(value.notes, `${path}.notes`, "dogfood report"),
  };
}

export function assertDogfoodReport(value: unknown): asserts value is DogfoodReport {
  if (!isRecord(value)) {
    throw new Error(`Invalid dogfood report at $: expected an object, got ${typeof value}`);
  }
  assertNoExtraKeys(value, REPORT_KEYS, "dogfood report", "$");
  if (!isRecord(value.cleanup)) {
    throw new Error("Invalid dogfood report at $.cleanup: expected an object");
  }
  assertNoExtraKeys(value.cleanup, CLEANUP_KEYS, "dogfood report", "$.cleanup");
  if (!Array.isArray(value.journeys)) {
    throw new Error("Invalid dogfood report at $.journeys: expected an array");
  }
  expectVerdict(value.verdict, "$.verdict", "dogfood report");
  expectString(value.summary, "$.summary", "dogfood report");
  expectString(value.head_sha, "$.head_sha", "dogfood report");
  expectStringArray(value.blockers, "$.blockers", "dogfood report");
  expectStringArray(value.cleanup.projects_deleted, "$.cleanup.projects_deleted", "dogfood report");
  for (let index = 0; index < value.journeys.length; index++) {
    parseJourney(value.journeys[index], `$.journeys[${index}]`);
  }
}

export function makeCrashStub(headSha: string, reason: string): DogfoodReport {
  return {
    verdict: "no-go",
    summary: "Dogfood agent did not complete for this run.",
    head_sha: headSha,
    journeys: [],
    blockers: [reason],
    cleanup: { projects_deleted: [] },
  };
}

const VERDICT_HEADING = /^## Functional dogfood: `(go|conditional|no-go)`/m;
const CLI_HEAD_LINE = /^CLI HEAD: `([^`]+)`/m;

export function extractDogfoodVerdict(body: string): DogfoodVerdict | undefined {
  if (!body.includes(AI_DOGFOOD_MARKER)) {
    return undefined;
  }
  const match = VERDICT_HEADING.exec(body);
  if (!match) {
    return undefined;
  }
  const verdict = match[1];
  if (verdict !== "go" && verdict !== "conditional" && verdict !== "no-go") {
    return undefined;
  }
  return verdict;
}

export function extractDogfoodHeadSha(body: string): string | undefined {
  const match = CLI_HEAD_LINE.exec(body);
  return match?.[1];
}

function sanitizeTableCell(text: string): string {
  return sanitizeModelText(text)
    .replaceAll("|", "\\|")
    .replace(/[\r\n]+/g, " ");
}

function sanitizeCodeSpan(text: string): string {
  return sanitizeModelText(text).replaceAll("`", "");
}

export function renderDogfoodComment(report: DogfoodReport, footer: DogfoodCommentFooter): string {
  const journeyRows =
    report.journeys.length === 0
      ? "_No journeys recorded._"
      : [
          "| Id | Result | Commands | Notes |",
          "| --- | --- | --- | --- |",
          ...report.journeys.map(
            (journey) =>
              `| ${sanitizeTableCell(journey.id)} | \`${journey.result}\` | ` +
              `${sanitizeTableCell(journey.commands.join(" · "))} | ${sanitizeTableCell(journey.notes)} |`,
          ),
        ].join("\n");

  const blockers =
    report.blockers.length === 0
      ? "_None._"
      : report.blockers.map((item) => `- ${sanitizeModelText(item)}`).join("\n");

  const deleted =
    report.cleanup.projects_deleted.length === 0
      ? "_None recorded._"
      : report.cleanup.projects_deleted.map((ref) => `- \`${sanitizeCodeSpan(ref)}\``).join("\n");

  return [
    `## Functional dogfood: \`${report.verdict}\``,
    "",
    sanitizeModelText(report.summary),
    "",
    `CLI HEAD: \`${sanitizeCodeSpan(report.head_sha)}\``,
    "",
    "### Journeys",
    "",
    journeyRows,
    "",
    "### Blockers",
    "",
    blockers,
    "",
    "### Cleanup",
    "",
    deleted,
    "",
    "---",
    `Model: \`${footer.model}\` · [Workflow run](${footer.runUrl})`,
    "",
    "This report is advisory. A maintainer can request another with `/ai-dogfood-and-review`.",
    "",
    AI_DOGFOOD_MARKER,
    "",
  ].join("\n");
}

export interface IssueComment {
  id: number;
  body: string;
  authorLogin: string;
}

export interface ReportIo {
  listIssueComments: (prNumber: number) => Promise<IssueComment[]>;
  postIssueComment: (prNumber: number, body: string) => Promise<void>;
}

/** Latest bot-authored dogfood comment wins. When `expectedHeadSha` is set,
 * skip reports whose `CLI HEAD` line does not match the current PR head. */
export function pickLatestDogfoodComment(
  comments: IssueComment[],
  expectedHeadSha?: string,
): IssueComment | undefined {
  for (let index = comments.length - 1; index >= 0; index--) {
    const comment = comments[index];
    if (
      !comment ||
      comment.authorLogin !== WORKFLOW_BOT_LOGIN ||
      !comment.body.includes(AI_DOGFOOD_MARKER)
    ) {
      continue;
    }
    if (expectedHeadSha !== undefined && extractDogfoodHeadSha(comment.body) !== expectedHeadSha) {
      continue;
    }
    return comment;
  }
  return undefined;
}

export async function fetchDogfoodReport(
  io: ReportIo,
  prNumber: number,
  expectedHeadSha?: string,
): Promise<{ body: string; verdict: DogfoodVerdict | undefined }> {
  const comments = await io.listIssueComments(prNumber);
  const latest = pickLatestDogfoodComment(comments, expectedHeadSha);
  if (!latest) {
    return { body: "", verdict: undefined };
  }
  return { body: latest.body, verdict: extractDogfoodVerdict(latest.body) };
}

/** GitHub 403/transient errors must not sink `/ai-review`. */
export async function fetchDogfoodReportOrEmpty(
  io: ReportIo,
  prNumber: number,
  expectedHeadSha?: string,
): Promise<{ body: string; verdict: DogfoodVerdict | undefined }> {
  try {
    return await fetchDogfoodReport(io, prNumber, expectedHeadSha);
  } catch (error) {
    console.warn(`Could not fetch dogfood report: ${String(error)}`);
    return { body: "", verdict: undefined };
  }
}

export async function postDogfoodComment(
  io: ReportIo,
  prNumber: number,
  report: DogfoodReport,
  footer: DogfoodCommentFooter,
): Promise<void> {
  await io.postIssueComment(prNumber, renderDogfoodComment(report, footer));
}

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
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub request failed (${response.status}) for ${url}: ${body}`);
  }
  return response;
}

function isRecordEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function githubJson<T>(
  response: Response,
  assert: (value: unknown) => asserts value is T,
): Promise<T> {
  const value: unknown = await response.json();
  assert(value);
  return value;
}

function assertRestIssueComments(
  value: unknown,
): asserts value is Array<{ id: number; body: string | null; user: { login: string } | null }> {
  const isEntry = (
    entry: unknown,
  ): entry is { id: number; body: string | null; user: { login: string } | null } =>
    isRecordEntry(entry) &&
    typeof entry.id === "number" &&
    (entry.body === null || typeof entry.body === "string") &&
    (entry.user === null || (isRecordEntry(entry.user) && typeof entry.user.login === "string"));
  if (!Array.isArray(value) || !value.every(isEntry)) {
    throw new Error("Malformed GitHub response: expected an array of issue comments.");
  }
}

async function listAllCommentPages(
  token: string,
  url: string,
): Promise<Array<{ id: number; body: string | null; user: { login: string } | null }>> {
  const entries: Array<{ id: number; body: string | null; user: { login: string } | null }> = [];
  for (let page = 1; ; page++) {
    const separator = url.includes("?") ? "&" : "?";
    const response = await githubFetch(`${url}${separator}per_page=100&page=${page}`, token);
    const batch = await githubJson(response, assertRestIssueComments);
    entries.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return entries;
}

function makeGithubReportIo(token: string, base: string): ReportIo {
  return {
    listIssueComments: async (prNumber) => {
      const entries = await listAllCommentPages(token, `${base}/issues/${prNumber}/comments`);
      return entries.map((entry) => ({
        id: entry.id,
        body: entry.body ?? "",
        authorLogin: entry.user?.login ?? "",
      }));
    },
    postIssueComment: async (prNumber, body) => {
      await githubFetch(`${base}/issues/${prNumber}/comments`, token, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },
  };
}

function writeGithubOutput(entries: Record<string, string>): void {
  const outputFile = process.env["GITHUB_OUTPUT"];
  if (!outputFile) {
    return;
  }
  const lines = Object.entries(entries).map(([name, value]) => {
    const delimiter = `ghadelim_${crypto.randomUUID()}`;
    return `${name}<<${delimiter}\n${value}\n${delimiter}`;
  });
  appendFileSync(outputFile, `${lines.join("\n")}\n`);
}

async function runValidate(path: string): Promise<void> {
  const raw: unknown = JSON.parse(await Bun.file(path).text());
  assertDogfoodReport(raw);
  console.log(`OK: ${path} matches the dogfood report schema (verdict=${raw.verdict}).`);
}

async function runRedact(path: string): Promise<void> {
  const raw: unknown = JSON.parse(await Bun.file(path).text());
  const redacted = redactSecretsDeep(raw);
  await Bun.write(path, `${JSON.stringify(redacted, null, 2)}\n`);
  console.log(`OK: redacted secrets in ${path}.`);
}

async function runStub(): Promise<void> {
  const path = requireEnv("REPORT_PATH");
  const headSha = requireEnv("HEAD_SHA");
  const reason =
    process.env["STUB_REASON"]?.trim() || "Dogfood agent crashed or produced invalid output.";
  const stub = makeCrashStub(headSha, reason);
  await Bun.write(path, `${JSON.stringify(stub, null, 2)}\n`);
  console.log(`Wrote crash stub to ${path}.`);
}

async function runPost(): Promise<void> {
  const token = requireEnv("GITHUB_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const [owner, repo] = repository.split("/");
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const io = makeGithubReportIo(token, base);
  const prNumber = Number(requireEnv("PR_NUMBER"));
  const reportPath = requireEnv("REPORT_PATH");
  const raw: unknown = JSON.parse(await Bun.file(reportPath).text());
  assertDogfoodReport(raw);
  await postDogfoodComment(io, prNumber, raw, {
    runUrl: requireEnv("RUN_URL"),
    model: requireEnv("DOGFOOD_MODEL"),
  });
  console.log(`Posted dogfood report on PR #${prNumber} (verdict=${raw.verdict}).`);
}

async function runFetch(): Promise<void> {
  const outPath = requireEnv("DOGFOOD_REPORT_PATH");
  try {
    const token = requireEnv("GITHUB_TOKEN");
    const repository = requireEnv("GITHUB_REPOSITORY");
    const [owner, repo] = repository.split("/");
    const base = `https://api.github.com/repos/${owner}/${repo}`;
    const io = makeGithubReportIo(token, base);
    const prNumber = Number(requireEnv("PR_NUMBER"));
    const rawHeadSha = process.env["HEAD_SHA"];
    let expectedHeadSha: string | undefined;
    if (rawHeadSha !== undefined) {
      expectedHeadSha = rawHeadSha.trim();
      if (expectedHeadSha === "") {
        console.warn("HEAD_SHA is empty; not using a dogfood report.");
        await Bun.write(outPath, "");
        writeGithubOutput({ verdict: "" });
        return;
      }
    }
    const { body, verdict } = await fetchDogfoodReportOrEmpty(io, prNumber, expectedHeadSha);
    await Bun.write(outPath, body);
    writeGithubOutput({ verdict: verdict ?? "" });
    console.log(
      verdict
        ? `Fetched dogfood report for PR #${prNumber} (verdict=${verdict}).`
        : `No dogfood report on PR #${prNumber}.`,
    );
  } catch (error) {
    // A 403/transient failure must not sink `/ai-review`; reviewers just miss
    // the optional runtime evidence.
    console.warn(`Could not fetch dogfood report: ${String(error)}`);
    await Bun.write(outPath, "");
    writeGithubOutput({ verdict: "" });
  }
}

function requireArg(value: string | undefined, command: string): string {
  if (!value) {
    throw new Error(`Usage: bun .github/scripts/ai-dogfood/post-report.ts ${command} <path>`);
  }
  return value;
}

async function main(): Promise<void> {
  const [, , command, arg] = process.argv;

  switch (command) {
    case "validate-report": {
      await runValidate(requireArg(arg, "validate-report"));
      return;
    }
    case "redact": {
      await runRedact(requireArg(arg, "redact"));
      return;
    }
    case "stub":
      await runStub();
      return;
    case "post":
      await runPost();
      return;
    case "fetch":
      await runFetch();
      return;
    default:
      throw new Error(
        `Unknown command: ${command ?? "<none>"}. Expected one of: validate-report, redact, stub, post, fetch.`,
      );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
