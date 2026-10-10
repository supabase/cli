import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  type GitRunner,
  githubRequest,
  gitOrThrow,
  makeGit,
  requireEnv,
} from "./promotion-shared.ts";
import { type AgentDecision, createAgentCaller, isDecisionList, loadSchema } from "./sync-agent.ts";
import { redactSecrets, redactSecretsDeep } from "./ai-review/post-review.ts";
import { type ResolutionPlan, agentWrittenText } from "./sync-branches.ts";
import {
  type CheckFixer,
  type CheckResult,
  type Checker,
  checkAndFix,
  runChecks,
} from "./sync-checks.ts";
import { checkFixer, gatherPrecedents } from "./sync-resolve.ts";

export interface RepairFailure {
  name: string;
  runId: number;
  jobId: number;
  conclusion: string;
}

export interface RepairFinding {
  threadId: string;
  commentId: number;
  path: string;
  line: number | null;
  body: string;
}

/** One repair round on the open sync pull request, planned by the settle step. */
export interface RepairPlan {
  source: string;
  target: string;
  pullRequest: number;
  /** The sync branch head the repair starts from and leases against. */
  head: string;
  round: number;
  failures: RepairFailure[];
  findings: RepairFinding[];
  /** The AI review's summary, passed on the first round after the review. */
  reviewBody: string | null;
}

export interface FindingReply {
  commentId: number;
  disposition: "fixed" | "declined";
  reply: string;
}

export interface RepairOutcome {
  status: "repaired" | "unresolved";
  summary: string;
  files: { path: string; resolution: string }[];
  findings: FindingReply[];
  decisions: AgentDecision[];
}

export interface RepairResult {
  head: string;
  outcome: RepairOutcome | null;
  /** Why the round produced no repair, if it did not. */
  failure?: string;
  check?: CheckResult;
}

export type RepairAgent = () => Promise<RepairOutcome | string>;

const MAX_LOG_LINES = 300;

/** Validates the agent's structured output; anything else is treated as no repair. */
export function parseRepairOutcome(value: unknown): RepairOutcome | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const valid =
    (candidate.status === "repaired" || candidate.status === "unresolved") &&
    typeof candidate.summary === "string" &&
    Array.isArray(candidate.files) &&
    candidate.files.every(
      (file: Record<string, unknown>) =>
        typeof file?.path === "string" && typeof file.resolution === "string",
    ) &&
    Array.isArray(candidate.findings) &&
    candidate.findings.every(
      (finding: Record<string, unknown>) =>
        Number.isSafeInteger(finding?.commentId) &&
        (finding.disposition === "fixed" || finding.disposition === "declined") &&
        typeof finding.reply === "string",
    ) &&
    isDecisionList(candidate.decisions);
  return valid ? (candidate as unknown as RepairOutcome) : undefined;
}

function fenced(text: string): string {
  return ["````text", text, "````"].join("\n");
}

/**
 * The branches whose version of the finding's file already has the commented line verbatim. A line that exists on
 * either side predates the merge, which keeps the repair from fixing issues the sync did not introduce.
 */
export function findingOrigins(git: GitRunner, plan: RepairPlan, finding: RepairFinding): string[] {
  if (finding.line === null) {
    return [];
  }
  const file = git(["show", `${plan.head}:${finding.path}`]);
  const line = file.status === 0 ? file.stdout.split("\n")[finding.line - 1]?.trim() : undefined;
  if (!line) {
    return [];
  }
  return [plan.source, plan.target].filter((branch) => {
    const side = git(["show", `refs/remotes/origin/${branch}:${finding.path}`]);
    return side.status === 0 && side.stdout.split("\n").some((text) => text.trim() === line);
  });
}

/** Writes what the round must address: failing jobs with their annotations and log tails, and open review findings. */
export function writeRepairContext(
  contextDir: string,
  plan: RepairPlan,
  failureDetails: Map<number, { annotations: string; log: string }>,
  origins: Map<number, string[]>,
): void {
  const failures = plan.failures.flatMap((failure) => {
    const details = failureDetails.get(failure.jobId);
    return [
      "",
      `## ${failure.name} (${failure.conclusion}, job ${failure.jobId})`,
      "",
      "### Annotations",
      details?.annotations || "(none)",
      "",
      `### Last ${MAX_LOG_LINES} log lines`,
      fenced(details?.log || "(unavailable)"),
    ];
  });
  writeFileSync(
    join(contextDir, "ci-failures.md"),
    [
      "# Failing CI jobs",
      "",
      "Each failed twice, so a flake is unlikely.",
      ...(failures.length > 0 ? failures : ["", "None."]),
      "",
    ].join("\n"),
  );

  const findings = plan.findings.flatMap((finding) => {
    const branches = origins.get(finding.commentId) ?? [];
    return [
      "",
      `## Finding ${finding.commentId} on \`${finding.path}\`${finding.line === null ? "" : `:${finding.line}`}`,
      "",
      branches.length > 0
        ? `The commented line already exists on ${branches.map((branch) => `\`${branch}\``).join(" and ")}, so the issue likely predates the merge.`
        : `The commented line is on neither \`${plan.source}\` nor \`${plan.target}\`; the merge or its fixes wrote it.`,
      "",
      fenced(finding.body),
    ];
  });
  writeFileSync(
    join(contextDir, "review-findings.md"),
    [
      "# Open AI review findings",
      ...(plan.reviewBody ? ["", "## Review summary", "", fenced(plan.reviewBody)] : []),
      ...(findings.length > 0 ? findings : ["", "None."]),
      "",
    ].join("\n"),
  );
}

function dropUnstaged(git: GitRunner): void {
  gitOrThrow(git, ["checkout", "-q", "--", "."]);
  gitOrThrow(git, ["clean", "-fdq"]);
}

/**
 * Runs one repair round on the sync branch head: the agent's edits, then the quality checks with one more fix,
 * committed on top of the head. Replies for findings the plan does not list are dropped.
 */
export async function repair(
  git: GitRunner,
  plan: RepairPlan,
  agent: RepairAgent,
  check: Checker,
  fix: CheckFixer,
  message: string,
): Promise<RepairResult> {
  gitOrThrow(git, ["checkout", "-q", "--detach", plan.head]);
  const outcome = await agent();
  if (typeof outcome === "string" || outcome.status === "unresolved") {
    dropUnstaged(git);
    return typeof outcome === "string"
      ? { head: plan.head, outcome: null, failure: outcome }
      : {
          head: plan.head,
          outcome,
          failure: `The agent did not repair the branch: ${outcome.summary}`,
        };
  }
  const known = new Set(plan.findings.map(({ commentId }) => commentId));
  const findings = outcome.findings.filter(({ commentId }) => known.has(commentId));
  gitOrThrow(git, ["add", "-A"]);
  const checkResult = await checkAndFix(git, check, fix, message);
  return {
    head: gitOrThrow(git, ["rev-parse", "HEAD"]),
    outcome: { ...outcome, findings },
    check: checkResult,
  };
}

function logTail(log: string): string {
  const lines = log
    .split("\n")
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ""))
    .filter((line) => line.trim() !== "");
  return lines.slice(-MAX_LOG_LINES).join("\n");
}

async function fetchJobLog(token: string, repository: string, jobId: number): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/jobs/${jobId}/logs`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    },
  );
  return response.ok ? logTail(await response.text()) : "";
}

async function fetchFailureDetails(
  token: string,
  repository: string,
  plan: RepairPlan,
): Promise<Map<number, { annotations: string; log: string }>> {
  const details = new Map<number, { annotations: string; log: string }>();
  for (const { jobId } of plan.failures) {
    const annotations = await githubRequest<
      { path: string; start_line: number; annotation_level: string; message: string }[]
    >(token, `/repos/${repository}/check-runs/${jobId}/annotations`).catch(() => []);
    details.set(jobId, {
      annotations: annotations
        .map(
          ({ path, start_line, annotation_level, message }) =>
            `- ${annotation_level} ${path}:${start_line}: ${message.split("\n")[0]}`,
        )
        .join("\n"),
      log: await fetchJobLog(token, repository, jobId),
    });
  }
  return details;
}

async function main(): Promise<void> {
  const plan = JSON.parse(requireEnv("REPAIR")) as RepairPlan;
  const workDir = resolve(requireEnv("WORK_DIR"));
  const outputDir = resolve(requireEnv("OUTPUT_DIR"));
  const contextDir = mkdtempSync(join(tmpdir(), "sync-context-"));
  const token = requireEnv("GH_TOKEN");
  const repository = requireEnv("REPOSITORY");
  const repairPrompt = readFileSync(".github/sync-branches/repair-prompt.md", "utf8");
  const fixPrompt = readFileSync(".github/sync-branches/fix-prompt.md", "utf8");
  const repairSchema = loadSchema(readFileSync(".github/sync-branches/repair.schema.json", "utf8"));
  const fixSchema = loadSchema(
    readFileSync(".github/sync-branches/resolution.schema.json", "utf8"),
  );
  mkdirSync(outputDir, { recursive: true });

  const git = makeGit(workDir);
  const pair: ResolutionPlan = {
    source: plan.source,
    target: plan.target,
    base: plan.head,
    merges: [],
    expectedSyncHead: plan.head,
    pullRequest: plan.pullRequest,
  };
  const precedents = await gatherPrecedents(
    (path) => githubRequest(token, path),
    git,
    repository,
    pair,
  );
  writeFileSync(join(contextDir, "precedents.md"), precedents.markdown);
  gitOrThrow(git, [
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${plan.source}:refs/remotes/origin/${plan.source}`,
    `+refs/heads/${plan.target}:refs/remotes/origin/${plan.target}`,
  ]);
  writeRepairContext(
    contextDir,
    plan,
    await fetchFailureDetails(token, repository, plan),
    new Map(
      plan.findings.map((finding) => [finding.commentId, findingOrigins(git, plan, finding)]),
    ),
  );

  const call = createAgentCaller({
    workDir,
    contextDir,
    cliDir: requireEnv("CLAUDE_CLI_DIR"),
    image: requireEnv("AGENT_IMAGE"),
    model: requireEnv("CLAUDE_MODEL"),
  });
  console.log(
    `Claude: repair round ${plan.round} (${plan.failures.length} failing jobs, ${plan.findings.length} findings)…`,
  );
  let result = await repair(
    git,
    plan,
    async () => {
      const run = call(repairPrompt, repairSchema, parseRepairOutcome);
      return typeof run === "string" ? run : run.outcome;
    },
    () => runChecks(workDir, requireEnv("CHECK_IMAGE")),
    checkFixer(call, contextDir, fixSchema, fixPrompt),
    `chore(repo): address checks and review on sync/${plan.source}-into-${plan.target}`,
  );

  // The agent's container holds the API key; nothing secret-shaped it wrote may reach the artifact or the branch.
  const written = result.head === plan.head ? "" : agentWrittenText(git, plan.head, result.head);
  if (redactSecrets(written) !== written) {
    result = {
      head: plan.head,
      outcome: null,
      failure: "The agent's changes contain secret-shaped text, so they were discarded.",
    };
  }
  if (result.head !== plan.head) {
    gitOrThrow(git, ["update-ref", "refs/sync/resolved", result.head]);
    gitOrThrow(git, [
      "bundle",
      "create",
      join(outputDir, "resolved.bundle"),
      "refs/sync/resolved",
      `^${plan.head}`,
    ]);
  }
  writeFileSync(join(outputDir, "result.json"), JSON.stringify(redactSecretsDeep(result), null, 2));
  console.log(
    result.failure
      ? `::warning::No repair: ${result.failure}`
      : `Repair round ${plan.round}: head ${result.head}.`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
