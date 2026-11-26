import type { CliConfigTableRuleIssue } from "../lib/table-rule-issue.ts";

/** Sms providers in the priority order the provider rule checks, with the fields each requires. */
export const SMS_PROVIDER_REQUIRED_FIELDS = [
  ["twilio", ["account_sid", "message_service_sid", "auth_token"]],
  ["twilio_verify", ["account_sid", "message_service_sid", "auth_token"]],
  ["messagebird", ["originator", "access_key"]],
  ["textlocal", ["sender", "api_key"]],
  ["vonage", ["from", "api_key", "api_secret"]],
] as const;

type SmsProviderName = (typeof SMS_PROVIDER_REQUIRED_FIELDS)[number][0];

interface SmsProviderSwitchEntry {
  readonly enabled: boolean;
  readonly [field: string]: string | boolean | undefined;
}

export type SmsProviderSwitchInput = Readonly<
  Partial<Record<SmsProviderName, SmsProviderSwitchEntry>>
>;

/**
 * Validates providers in a fixed priority order, checking only the first one whose `enabled`
 * is true; a later enabled-but-incomplete provider is never inspected, so a
 * stale secondary `[auth.sms.*]` block doesn't cause a rejection.
 */
function validateSmsProviderSwitch(value: SmsProviderSwitchInput) {
  for (const [provider, fields] of SMS_PROVIDER_REQUIRED_FIELDS) {
    const entry = value[provider];
    if (entry?.enabled !== true) continue;
    const field = fields.find((name) => (entry[name] ?? "") === "");
    return field === undefined
      ? undefined
      : {
          path: [provider, field],
          issue: `Missing required field in config: auth.sms.${provider}.${field}`,
        };
  }
  return undefined;
}

/** The sms provider-switch rule's issues; paths are relative to `[auth.sms]`. */
export function cliConfigSmsProviderIssues(
  value: SmsProviderSwitchInput,
): ReadonlyArray<CliConfigTableRuleIssue> {
  const found = validateSmsProviderSwitch(value);
  return found === undefined ? [] : [{ path: found.path, message: found.issue }];
}
