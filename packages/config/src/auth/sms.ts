import { Effect, Schema } from "effect";
import { secret } from "../lib/env.ts";
import { type CliConfigTableRuleIssue, tableRuleFilter } from "../lib/table-rule.ts";

const tags = ["auth"];

const links = {
  auth: {
    name: "Auth Server configuration",
    link: "https://supabase.com/docs/reference/auth",
  },
  phoneLogin: (provider: string) => ({
    name: `Enabling Phone Login (${provider})`,
    link: `https://supabase.com/docs/guides/auth/phone-login?showSmsProvider=${provider}#enabling-phone-login`,
  }),
};

const defaultSms = {};
const defaultEnableSignup = false;
const defaultEnableConfirmations = false;
const defaultTemplate = "Your code is {{ .Code }}";
const defaultMaxFrequency = "5s";
const defaultOtpLength = 6;
const defaultOtpExpiry = 60;
const defaultTwilio = {};
const defaultTwilioEnabled = false;
const defaultTwilioAccountSid = "";
const defaultTwilioMessageServiceSid = "";
const defaultTwilioVerify = {};
const defaultTwilioVerifyEnabled = false;
const defaultMessagebird = {};
const defaultMessagebirdEnabled = false;
const defaultTextlocal = {};
const defaultTextlocalEnabled = false;
const defaultVonage = {};
const defaultVonageEnabled = false;

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

export const sms = Schema.Struct({
  enabled: Schema.optionalKey(
    Schema.Boolean.annotate({
      default: defaultEnableSignup,
      description:
        "Allow/disallow the phone provider. When false, users can't sign up or sign in with a phone number (password or SMS OTP); set `auth.enable_signup = false` to block new signups only.",
      tags,
      links: [links.auth],
    }),
  ),
  enable_signup: Schema.Boolean.annotate({
    default: defaultEnableSignup,
    description:
      "Deprecated: use `auth.sms.enabled` instead. Allow/disallow the phone provider; when false, users can't sign up or sign in with a phone number.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEnableSignup))),
  enable_confirmations: Schema.Boolean.annotate({
    default: defaultEnableConfirmations,
    description: "If enabled, users need to confirm their phone number before signing in.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEnableConfirmations))),
  template: Schema.String.annotate({
    default: defaultTemplate,
    description: "The template to use for the SMS message.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultTemplate))),
  max_frequency: Schema.String.annotate({
    default: defaultMaxFrequency,
    description:
      "Controls the minimum amount of time that must pass before sending another sms otp.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultMaxFrequency))),
  otp_length: Schema.Finite.annotate({
    default: defaultOtpLength,
    description: "Number of characters used in the SMS OTP.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultOtpLength))),
  otp_expiry: Schema.Finite.annotate({
    default: defaultOtpExpiry,
    description: "Number of seconds before the SMS OTP expires.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultOtpExpiry))),
  twilio: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultTwilioEnabled,
      description: "Enable/disable Twilio provider for phone login.",
      tags,
      links: [links.phoneLogin("Twilio")],
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultTwilioEnabled))),
    account_sid: Schema.String.annotate({
      default: defaultTwilioAccountSid,
      description: "The account SID for the Twilio API.",
      tags,
      links: [links.phoneLogin("Twilio")],
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultTwilioAccountSid))),
    message_service_sid: Schema.String.annotate({
      default: defaultTwilioMessageServiceSid,
      description: "The message service SID for the Twilio API.",
      tags,
      links: [links.phoneLogin("Twilio")],
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultTwilioMessageServiceSid))),
    content_sid: Schema.optionalKey(
      Schema.String.annotate({
        description: "The content SID of a WhatsApp/Messaging Content Template for the Twilio API.",
        tags,
        links: [links.phoneLogin("Twilio")],
      }),
    ),
    auth_token: Schema.optionalKey(
      secret({
        examples: ["env(SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN)"],
        description: "The auth token for the Twilio API.",
        tags,
        links: [links.phoneLogin("Twilio")],
      }),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultTwilio }))),
  twilio_verify: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultTwilioVerifyEnabled,
      description: "Enable/disable Twilio Verify provider for phone verification.",
      tags,
      links: [links.phoneLogin("Twilio")],
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultTwilioVerifyEnabled))),
    account_sid: Schema.optionalKey(
      Schema.String.annotate({
        description: "The account SID for the Twilio API.",
        tags,
        links: [links.phoneLogin("Twilio")],
      }),
    ),
    message_service_sid: Schema.optionalKey(
      Schema.String.annotate({
        description: "The message service SID for the Twilio API.",
        tags,
        links: [links.phoneLogin("Twilio")],
      }),
    ),
    auth_token: Schema.optionalKey(
      secret({
        description: "The auth token for the Twilio API.",
        tags,
        links: [links.phoneLogin("Twilio")],
      }),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultTwilioVerify }))),
  messagebird: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultMessagebirdEnabled,
      description: "Enable/disable MessageBird provider for phone login.",
      tags,
      links: [links.phoneLogin("MessageBird")],
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultMessagebirdEnabled))),
    originator: Schema.optionalKey(
      Schema.String.annotate({
        description: "The originator of the SMS message.",
        tags,
        links: [links.phoneLogin("MessageBird")],
      }),
    ),
    access_key: Schema.optionalKey(
      secret({
        description: "The access key for the MessageBird API.",
        tags,
        links: [links.phoneLogin("MessageBird")],
      }),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultMessagebird }))),
  textlocal: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultTextlocalEnabled,
      description: "Enable/disable Textlocal provider for phone login.",
      tags,
      links: [links.phoneLogin("Textlocal%2520(Community%2520Supported)")],
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultTextlocalEnabled))),
    sender: Schema.optionalKey(
      Schema.String.annotate({
        description: "The sender of the SMS message.",
        tags,
        links: [links.phoneLogin("Textlocal%2520(Community%2520Supported)")],
      }),
    ),
    api_key: Schema.optionalKey(
      secret({
        description: "The API key for the Textlocal API.",
        tags,
        links: [links.phoneLogin("Textlocal%2520(Community%2520Supported)")],
      }),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultTextlocal }))),
  vonage: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultVonageEnabled,
      description: "Enable/disable Vonage provider for phone login.",
      tags,
      links: [links.phoneLogin("Vonage")],
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultVonageEnabled))),
    from: Schema.optionalKey(
      Schema.String.annotate({
        description: "The sender of the SMS message.",
        tags,
        links: [links.phoneLogin("Vonage")],
      }),
    ),
    api_key: Schema.optionalKey(
      Schema.String.annotate({
        description: "The API key for the Vonage API.",
        tags,
        links: [links.phoneLogin("Vonage")],
      }),
    ),
    api_secret: Schema.optionalKey(
      secret({
        description: "The API secret for the Vonage API.",
        tags,
        links: [links.phoneLogin("Vonage")],
      }),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultVonage }))),
  test_otp: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: "Use pre-defined map of phone number to OTP for testing.",
      tags,
      links: [links.auth],
    }),
  ),
})
  .check(tableRuleFilter(cliConfigSmsProviderIssues))
  .pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultSms })));
