import { Schema } from "effect";
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

function requiredWhenEnabled<
  T extends Record<string, string | number | boolean | undefined> & { enabled: boolean },
>(path: string, predicate: (value: T) => boolean, message: string) {
  return Schema.makeFilter((value: T) => {
    if (!value.enabled || predicate(value)) {
      return undefined;
    }

    return {
      path: [path],
      message,
    };
  });
}

export const sms = Schema.Struct({
  enable_signup: Schema.Boolean.annotate({
    default: defaultEnableSignup,
    description: "Allow/disallow new user signups via SMS to your project.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnableSignup)),
  enable_confirmations: Schema.Boolean.annotate({
    default: defaultEnableConfirmations,
    description: "If enabled, users need to confirm their phone number before signing in.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnableConfirmations)),
  template: Schema.String.annotate({
    default: defaultTemplate,
    description: "The template to use for the SMS message.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultTemplate)),
  max_frequency: Schema.String.annotate({
    default: defaultMaxFrequency,
    description:
      "Controls the minimum amount of time that must pass before sending another sms otp.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultMaxFrequency)),
  twilio: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultTwilioEnabled,
      description: "Enable/disable Twilio provider for phone login.",
      tags,
      links: [links.phoneLogin("Twilio")],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultTwilioEnabled)),
    account_sid: Schema.String.annotate({
      default: defaultTwilioAccountSid,
      description: "The account SID for the Twilio API.",
      tags,
      links: [links.phoneLogin("Twilio")],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultTwilioAccountSid)),
    message_service_sid: Schema.String.annotate({
      default: defaultTwilioMessageServiceSid,
      description: "The message service SID for the Twilio API.",
      tags,
      links: [links.phoneLogin("Twilio")],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultTwilioMessageServiceSid)),
    auth_token: Schema.optionalKey(
      secret({
        examples: ["env(SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN)"],
        description: "The auth token for the Twilio API.",
        tags,
        links: [links.phoneLogin("Twilio")],
      }),
    ),
  })
    .check(
      requiredWhenEnabled(
        "account_sid",
        (value) => value.account_sid !== "",
        "Missing required field in config: auth.sms.twilio.account_sid",
      ),
      requiredWhenEnabled(
        "message_service_sid",
        (value) => value.message_service_sid !== "",
        "Missing required field in config: auth.sms.twilio.message_service_sid",
      ),
      requiredWhenEnabled(
        "auth_token",
        (value) => value.auth_token !== undefined && value.auth_token !== "",
        "Missing required field in config: auth.sms.twilio.auth_token",
      ),
    )
    .pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultTwilio }))),
  twilio_verify: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultTwilioVerifyEnabled,
      description: "Enable/disable Twilio Verify provider for phone verification.",
      tags,
      links: [links.phoneLogin("Twilio")],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultTwilioVerifyEnabled)),
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
  })
    .check(
      requiredWhenEnabled(
        "account_sid",
        (value) => value.account_sid !== undefined && value.account_sid !== "",
        "Missing required field in config: auth.sms.twilio_verify.account_sid",
      ),
      requiredWhenEnabled(
        "message_service_sid",
        (value) => value.message_service_sid !== undefined && value.message_service_sid !== "",
        "Missing required field in config: auth.sms.twilio_verify.message_service_sid",
      ),
      requiredWhenEnabled(
        "auth_token",
        (value) => value.auth_token !== undefined && value.auth_token !== "",
        "Missing required field in config: auth.sms.twilio_verify.auth_token",
      ),
    )
    .pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultTwilioVerify }))),
  messagebird: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultMessagebirdEnabled,
      description: "Enable/disable MessageBird provider for phone login.",
      tags,
      links: [links.phoneLogin("MessageBird")],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultMessagebirdEnabled)),
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
  })
    .check(
      requiredWhenEnabled(
        "originator",
        (value) => value.originator !== undefined && value.originator !== "",
        "Missing required field in config: auth.sms.messagebird.originator",
      ),
      requiredWhenEnabled(
        "access_key",
        (value) => value.access_key !== undefined && value.access_key !== "",
        "Missing required field in config: auth.sms.messagebird.access_key",
      ),
    )
    .pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultMessagebird }))),
  textlocal: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultTextlocalEnabled,
      description: "Enable/disable Textlocal provider for phone login.",
      tags,
      links: [links.phoneLogin("Textlocal%2520(Community%2520Supported)")],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultTextlocalEnabled)),
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
  })
    .check(
      requiredWhenEnabled(
        "sender",
        (value) => value.sender !== undefined && value.sender !== "",
        "Missing required field in config: auth.sms.textlocal.sender",
      ),
      requiredWhenEnabled(
        "api_key",
        (value) => value.api_key !== undefined && value.api_key !== "",
        "Missing required field in config: auth.sms.textlocal.api_key",
      ),
    )
    .pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultTextlocal }))),
  vonage: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultVonageEnabled,
      description: "Enable/disable Vonage provider for phone login.",
      tags,
      links: [links.phoneLogin("Vonage")],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultVonageEnabled)),
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
  })
    .check(
      requiredWhenEnabled(
        "from",
        (value) => value.from !== undefined && value.from !== "",
        "Missing required field in config: auth.sms.vonage.from",
      ),
      requiredWhenEnabled(
        "api_key",
        (value) => value.api_key !== undefined && value.api_key !== "",
        "Missing required field in config: auth.sms.vonage.api_key",
      ),
      requiredWhenEnabled(
        "api_secret",
        (value) => value.api_secret !== undefined && value.api_secret !== "",
        "Missing required field in config: auth.sms.vonage.api_secret",
      ),
    )
    .pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultVonage }))),
  test_otp: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: "Use pre-defined map of phone number to OTP for testing.",
      tags,
      links: [links.auth],
    }),
  ),
}).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultSms })));
