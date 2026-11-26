import type { CliConfigTableRuleIssue } from "../lib/table-rule-issue.ts";

export interface SmtpInput {
  readonly enabled: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly pass?: string;
  readonly admin_email?: string;
}

const isFilled = (field: string | undefined) => field !== undefined && field !== "";

const smtpKeys = ["host", "port", "user", "pass", "admin_email"] as const;

export type SmtpRequirementKey = (typeof smtpKeys)[number];

const smtpRequirements: Record<SmtpRequirementKey, (value: SmtpInput) => boolean> = {
  host: (value: SmtpInput) => isFilled(value.host),
  port: (value: SmtpInput) => value.port !== undefined,
  user: (value: SmtpInput) => isFilled(value.user),
  pass: (value: SmtpInput) => isFilled(value.pass),
  admin_email: (value: SmtpInput) => isFilled(value.admin_email),
};

export function smtpRequirementIssues(
  value: SmtpInput,
  key: SmtpRequirementKey,
): ReadonlyArray<CliConfigTableRuleIssue> {
  return !value.enabled || smtpRequirements[key](value)
    ? []
    : [{ path: [key], message: `Missing required field in config: auth.email.smtp.${key}` }];
}

/** The `[auth.email.smtp]` required-when-enabled issues; paths are relative to that table. */
export function cliConfigSmtpIssues(
  value: SmtpInput,
  keys: ReadonlyArray<SmtpRequirementKey> = smtpKeys,
): ReadonlyArray<CliConfigTableRuleIssue> {
  return keys.flatMap((key) => smtpRequirementIssues(value, key));
}
