import { Effect, Schema } from "effect";
import { secret } from "../lib/env.ts";

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

interface SmsProviderSwitchInput {
  readonly twilio: {
    readonly enabled: boolean;
    readonly account_sid: string;
    readonly message_service_sid: string;
    readonly auth_token?: string;
  };
  readonly twilio_verify: {
    readonly enabled: boolean;
    readonly account_sid?: string;
    readonly message_service_sid?: string;
    readonly auth_token?: string;
  };
  readonly messagebird: {
    readonly enabled: boolean;
    readonly originator?: string;
    readonly access_key?: string;
  };
  readonly textlocal: {
    readonly enabled: boolean;
    readonly sender?: string;
    readonly api_key?: string;
  };
  readonly vonage: {
    readonly enabled: boolean;
    readonly from?: string;
    readonly api_key?: string;
    readonly api_secret?: string;
  };
}

function missing(provider: string, field: string) {
  return {
    path: [provider, field],
    issue: `Missing required field in config: auth.sms.${provider}.${field}`,
  };
}

/**
 * Go's `(s *sms) validate()` (`apps/cli-go/pkg/config/config.go:1348-1410`): a boolean `switch`
 * that inspects providers in a FIXED priority order — twilio, twilio_verify, messagebird,
 * textlocal, vonage — and validates ONLY the first one whose `enabled` is true, matching Go's
 * `switch` short-circuit semantics. A later enabled-but-incomplete provider is never even looked
 * at. This replaces five independent per-provider `requiredWhenEnabled` checks (one per provider
 * sub-struct) that used to validate EVERY enabled provider table regardless of priority — a real
 * Go-parity gap, since a stale secondary `[auth.sms.*]` block Go silently ignores could make this
 * schema reject a config Go accepts. `s.EnableSignup`'s own switch case (`config.go:1408-1410`, a
 * WARN-only "no SMS provider enabled" notice with no throwing equivalent) isn't reproduced here,
 * matching this package's established precedent of not porting WARN-only branches (e.g. the
 * `auth.captcha.secret`/`assertEnvLoaded` case).
 */
function validateSmsProviderSwitch(value: SmsProviderSwitchInput) {
  if (value.twilio.enabled) {
    if (value.twilio.account_sid === "") return missing("twilio", "account_sid");
    if (value.twilio.message_service_sid === "") {
      return missing("twilio", "message_service_sid");
    }
    if (value.twilio.auth_token === undefined || value.twilio.auth_token === "") {
      return missing("twilio", "auth_token");
    }
    return undefined;
  }
  if (value.twilio_verify.enabled) {
    if (value.twilio_verify.account_sid === undefined || value.twilio_verify.account_sid === "") {
      return missing("twilio_verify", "account_sid");
    }
    if (
      value.twilio_verify.message_service_sid === undefined ||
      value.twilio_verify.message_service_sid === ""
    ) {
      return missing("twilio_verify", "message_service_sid");
    }
    if (value.twilio_verify.auth_token === undefined || value.twilio_verify.auth_token === "") {
      return missing("twilio_verify", "auth_token");
    }
    return undefined;
  }
  if (value.messagebird.enabled) {
    if (value.messagebird.originator === undefined || value.messagebird.originator === "") {
      return missing("messagebird", "originator");
    }
    if (value.messagebird.access_key === undefined || value.messagebird.access_key === "") {
      return missing("messagebird", "access_key");
    }
    return undefined;
  }
  if (value.textlocal.enabled) {
    if (value.textlocal.sender === undefined || value.textlocal.sender === "") {
      return missing("textlocal", "sender");
    }
    if (value.textlocal.api_key === undefined || value.textlocal.api_key === "") {
      return missing("textlocal", "api_key");
    }
    return undefined;
  }
  if (value.vonage.enabled) {
    if (value.vonage.from === undefined || value.vonage.from === "") {
      return missing("vonage", "from");
    }
    if (value.vonage.api_key === undefined || value.vonage.api_key === "") {
      return missing("vonage", "api_key");
    }
    if (value.vonage.api_secret === undefined || value.vonage.api_secret === "") {
      return missing("vonage", "api_secret");
    }
    return undefined;
  }
  return undefined;
}

export const sms = Schema.Struct({
  enable_signup: Schema.Boolean.annotate({
    default: defaultEnableSignup,
    description: "Allow/disallow new user signups via SMS to your project.",
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
  .check(Schema.makeFilter(validateSmsProviderSwitch))
  .pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultSms })));
