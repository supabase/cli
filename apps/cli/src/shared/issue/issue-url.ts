import { Option } from "effect";

const ISSUE_NEW_URL = "https://github.com/supabase/cli/issues/new";
const MAX_FIELD_LENGTH = 1_500;
const MAX_URL_LENGTH = 8_000;
const TRUNCATED_SUFFIX = "\n\n[truncated by Supabase CLI]";

export const searchedExistingIssuesValue = "I have searched the existing issues.";
export const issueInstallMethodValues = [
  "brew",
  "bun",
  "npm",
  "pnpm",
  "yarn",
  "Docker image",
  "GitHub release binary",
  "Other",
] as const;

const issueInstallMethodValueSet = new Set<string>(issueInstallMethodValues);

export const issueTemplateContract = {
  bug: {
    template: "bug-report.yml",
    fields: [
      "affected-area",
      "cli-version",
      "os",
      "install-method",
      "command",
      "actual-output",
      "expected-behavior",
      "reproduce",
      "ticket-id",
      "docker-services",
      "additional-context",
    ],
    requiredFields: [
      "affected-area",
      "cli-version",
      "os",
      "command",
      "actual-output",
      "expected-behavior",
      "reproduce",
    ],
    optionValues: {
      "install-method": issueInstallMethodValues,
    },
  },
  feature: {
    template: "feature-request.yml",
    fields: [
      "existing-issues",
      "affected-area",
      "problem",
      "proposed-solution",
      "alternatives",
      "additional-context",
    ],
    requiredFields: ["affected-area", "problem", "proposed-solution"],
    optionValues: {
      "existing-issues": [searchedExistingIssuesValue],
    },
  },
  docs: {
    template: "docs.yml",
    fields: ["link", "issue-type", "problem", "improvement", "additional-context"],
    requiredFields: ["issue-type", "problem", "improvement"],
    optionValues: {},
  },
} as const;

type IssueTemplate = "bug-report.yml" | "feature-request.yml" | "docs.yml";

export type IssueUrlInput = {
  readonly template: IssueTemplate;
  readonly fields: Readonly<Record<string, string | undefined>>;
};

export function readIssueFlagValue(value: Option.Option<string>): string | undefined {
  if (Option.isNone(value)) return undefined;
  const trimmed = value.value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function truncateField(value: string, maxLength = MAX_FIELD_LENGTH): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= TRUNCATED_SUFFIX.length) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
}

function issueUrl(params: URLSearchParams): string {
  return `${ISSUE_NEW_URL}?${params.toString()}`;
}

function appendField(params: URLSearchParams, id: string, value: string | undefined) {
  if (value === undefined) return;
  params.set(id, truncateField(value));
  if (issueUrl(params).length <= MAX_URL_LENGTH) return;

  let bestFit: string | undefined;
  let lower = 0;
  let upper = Math.min(value.length, MAX_FIELD_LENGTH);
  while (lower <= upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    const candidate = truncateField(value, midpoint);
    params.set(id, candidate);
    if (issueUrl(params).length <= MAX_URL_LENGTH) {
      bestFit = candidate;
      lower = midpoint + 1;
    } else {
      upper = midpoint - 1;
    }
  }

  if (bestFit === undefined) {
    params.delete(id);
  } else {
    params.set(id, bestFit);
  }
}

export function buildIssueUrl(input: IssueUrlInput): string {
  const params = new URLSearchParams();
  params.set("template", input.template);
  for (const [id, value] of Object.entries(input.fields)) {
    appendField(params, id, value);
  }
  return issueUrl(params);
}

function validInstallMethod(value: string): string {
  return issueInstallMethodValueSet.has(value) ? value : "Other";
}

export function inferIssueInstallMethod(runtimeInfo: { readonly execPath: string }): string {
  const explicit = process.env["SUPABASE_INSTALL_METHOD"]?.trim();
  if (explicit) return validInstallMethod(explicit);

  const userAgent = process.env["npm_config_user_agent"]?.toLowerCase();
  if (userAgent?.startsWith("pnpm/")) return "pnpm";
  if (userAgent?.startsWith("npm/")) return "npm";
  if (userAgent?.startsWith("yarn/")) return "yarn";
  if (userAgent?.startsWith("bun/")) return "bun";

  const execPath = runtimeInfo.execPath.toLowerCase();
  if (execPath.includes("homebrew") || execPath.includes("/cellar/")) return "brew";
  if (execPath.includes("/node_modules/") || execPath.includes("\\node_modules\\")) return "npm";

  return "Other";
}
