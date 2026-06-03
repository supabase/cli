import { Option } from "effect";

const ISSUE_NEW_URL = "https://github.com/supabase/cli/issues/new";
const MAX_FIELD_LENGTH = 1_500;

export const searchedExistingIssuesValue = "I have searched the existing issues.";
export const issueInstallMethodValues = ["brew", "bun", "npm", "pnpm", "yarn", "Other"] as const;

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

function truncateField(value: string): string {
  if (value.length <= MAX_FIELD_LENGTH) return value;
  return `${value.slice(0, MAX_FIELD_LENGTH)}\n\n[truncated by Supabase CLI]`;
}

function appendField(params: URLSearchParams, id: string, value: string | undefined) {
  if (value === undefined) return;
  params.set(id, truncateField(value));
}

export function buildIssueUrl(input: IssueUrlInput): string {
  const params = new URLSearchParams();
  params.set("template", input.template);
  for (const [id, value] of Object.entries(input.fields)) {
    appendField(params, id, value);
  }
  return `${ISSUE_NEW_URL}?${params.toString()}`;
}

export function inferIssueInstallMethod(runtimeInfo: { readonly execPath: string }): string {
  const explicit = process.env["SUPABASE_INSTALL_METHOD"]?.trim();
  if (explicit) return explicit;

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
