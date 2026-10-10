import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requireEnv } from "./promotion-shared.ts";

export interface AgentDecision {
  paths: string[];
  question: string;
  chosen: string;
  alternative: string;
}

export interface AgentResolution {
  status: "resolved" | "unresolved";
  summary: string;
  files: { path: string; resolution: string; precedent: number | null }[];
  deletedFiles: string[];
  decisions: AgentDecision[];
}

export interface AgentSession {
  sessionId: string;
  home: string;
}

interface AgentRun<T> {
  outcome: T | string;
  /** The reported cost, or the call's whole budget when the call ended without reporting one. */
  costUsd: number;
  session: AgentSession;
}

/** Shared by every call of one run, so the run's budget and deadline bound all of them together. */
export interface AgentConfig {
  workDir: string;
  contextDir: string;
  cliDir: string;
  image: string;
  model: string;
}

const MAX_TURNS_PER_CALL = 150;
const MAX_USD_PER_CALL = 12;
const MAX_USD_PER_RUN = 80;
const MIN_CALL_USD = 1;
const MAX_MINUTES_PER_CALL = 25;
/** Below the workflow job's timeout, so a slow run still hands the merge to a person instead of being killed. */
const RUN_DEADLINE_MINUTES = 70;
/** A call with less time left than this would only be cut off. */
const MIN_CALL_MINUTES = 5;

/** A read-only explorer on a cheaper model, so broad searches do not spend the main model's tokens. */
const EXPLORER_AGENT = {
  explorer: {
    description:
      "Read-only repository search: finds files, symbols, callers, usages, and where code moved, and reports file:line answers. Use it for any search beyond the files you are editing.",
    prompt:
      "Search the repository read-only and answer with concise file:line findings. Do not resolve conflicts, judge behavior, or edit files.",
    tools: ["Read", "Grep", "Glob"],
    model: "haiku",
  },
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isDecisionList(value: unknown): value is AgentDecision[] {
  return (
    Array.isArray(value) &&
    value.every(
      (decision: Record<string, unknown>) =>
        isStringArray(decision?.paths) &&
        typeof decision.question === "string" &&
        typeof decision.chosen === "string" &&
        typeof decision.alternative === "string",
    )
  );
}

/** Validates the agent's structured output; anything else is treated as no resolution. */
export function parseResolution(value: unknown): AgentResolution | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const files = candidate.files;
  const valid =
    (candidate.status === "resolved" || candidate.status === "unresolved") &&
    typeof candidate.summary === "string" &&
    isStringArray(candidate.deletedFiles) &&
    Array.isArray(files) &&
    files.every(
      (file: Record<string, unknown>) =>
        typeof file?.path === "string" &&
        typeof file.resolution === "string" &&
        (file.precedent === null || Number.isSafeInteger(file.precedent)),
    ) &&
    isDecisionList(candidate.decisions);
  return valid ? (candidate as unknown as AgentResolution) : undefined;
}

interface CallOptions {
  prompt: string;
  schema: string;
  /** Continues this session, from the same home directory, instead of starting over. */
  resume?: AgentSession;
  timeoutMinutes: number;
  maxBudgetUsd: number;
}

/**
 * Runs Claude Code in a container that sees only the worktree (with `.git` read-only), the context
 * directory, and the API key, so a prompt-injected agent cannot reach the runner or other credentials.
 */
function runClaudeAgent<T>(
  config: AgentConfig,
  options: CallOptions,
  parse: (value: unknown) => T | undefined,
): AgentRun<T> {
  const session = options.resume ?? {
    sessionId: randomUUID(),
    home: mkdtempSync(join(tmpdir(), "sync-agent-home-")),
  };
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      user,
      "--env",
      "ANTHROPIC_API_KEY",
      "--env",
      "HOME=/home/agent",
      "--volume",
      `${config.workDir}:/work`,
      "--volume",
      `${join(config.workDir, ".git")}:/work/.git:ro`,
      "--volume",
      `${config.contextDir}:/context:ro`,
      "--volume",
      `${config.cliDir}:/opt/claude:ro`,
      "--volume",
      `${session.home}:/home/agent`,
      "--workdir",
      "/work",
      config.image,
      "/opt/claude/bin/claude",
      "--bare",
      "--strict-mcp-config",
      ...(options.resume ? ["--resume", session.sessionId] : ["--session-id", session.sessionId]),
      "-p",
      options.prompt,
      "--model",
      config.model,
      "--agents",
      JSON.stringify(EXPLORER_AGENT),
      "--output-format",
      "json",
      "--json-schema",
      options.schema,
      "--allowedTools",
      "Read,Grep,Glob,Edit,Write,Agent(explorer),Task(explorer)",
      "--disallowedTools",
      "Bash,BashOutput,KillShell,WebFetch,WebSearch,NotebookEdit,Agent(general-purpose),Task(general-purpose),Agent(Plan),Task(Plan)",
      "--add-dir",
      "/context",
      "--max-turns",
      String(MAX_TURNS_PER_CALL),
      "--max-budget-usd",
      options.maxBudgetUsd.toFixed(2),
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
      timeout: options.timeoutMinutes * 60 * 1000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ANTHROPIC_API_KEY: requireEnv("ANTHROPIC_API_KEY"),
      },
    },
  );
  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      outcome: timedOut
        ? `Claude timed out after ${options.timeoutMinutes} minutes.`
        : `Claude did not run: ${result.error.message}`,
      costUsd: timedOut ? options.maxBudgetUsd : 0,
      session,
    };
  }
  let output: {
    is_error?: boolean;
    subtype?: string;
    structured_output?: unknown;
    num_turns?: number;
    total_cost_usd?: number;
  };
  try {
    output = JSON.parse(result.stdout);
  } catch {
    return {
      outcome: `Claude exited with status ${result.status} without a result.`,
      costUsd: options.maxBudgetUsd,
      session,
    };
  }
  const costUsd = output.total_cost_usd ?? options.maxBudgetUsd;
  console.log(
    `Claude ${output.subtype ?? "finished"} after ${output.num_turns} turns for $${costUsd.toFixed(2)}.`,
  );
  const outcome =
    output.is_error || result.status !== 0
      ? `Claude stopped (${output.subtype ?? `exit ${result.status}`}) after ${output.num_turns} turns.`
      : (parse(output.structured_output) ?? "Claude returned no valid result.");
  return { outcome, costUsd, session };
}

export type AgentCaller = <T>(
  prompt: string,
  schema: string,
  parse: (value: unknown) => T | undefined,
  resume?: AgentSession,
) => AgentRun<T> | string;

/** Returns a caller whose calls stop, with the reason, once the run's budget or deadline is spent. */
export function createAgentCaller(config: AgentConfig): AgentCaller {
  const deadline = Date.now() + RUN_DEADLINE_MINUTES * 60 * 1000;
  let spentUsd = 0;
  return (prompt, schema, parse, resume) => {
    const budgetLeftUsd = MAX_USD_PER_RUN - spentUsd;
    if (budgetLeftUsd < MIN_CALL_USD) {
      return `The run already spent $${spentUsd.toFixed(2)} of its $${MAX_USD_PER_RUN} budget.`;
    }
    const minutesLeft = Math.floor((deadline - Date.now()) / 60_000);
    if (minutesLeft < MIN_CALL_MINUTES) {
      return `The run reached its ${RUN_DEADLINE_MINUTES}-minute deadline.`;
    }
    const run = runClaudeAgent(
      config,
      {
        prompt,
        schema,
        ...(resume ? { resume } : {}),
        timeoutMinutes: Math.min(MAX_MINUTES_PER_CALL, minutesLeft),
        maxBudgetUsd: Math.min(MAX_USD_PER_CALL, budgetLeftUsd),
      },
      parse,
    );
    spentUsd += run.costUsd;
    return run;
  };
}

/** Reads a JSON schema file and drops `$schema`, which the CLI's `--json-schema` does not accept. */
export function loadSchema(text: string): string {
  const { $schema: _, ...schema } = JSON.parse(text) as Record<string, unknown>;
  return JSON.stringify(schema);
}
