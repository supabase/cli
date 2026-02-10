import { s } from "jsonv-ts";
import { env } from "../lib/env";

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

export const sms = s
  .strictObject({
    enable_signup: s.boolean({
      default: true,
      description: "Allow/disallow new user signups via SMS to your project.",
      tags,
      links: [links.auth],
    }),
    enable_confirmations: s.boolean({
      default: false,
      description: "If enabled, users need to confirm their phone number before signing in.",
      tags,
      links: [links.auth],
    }),
    template: s.string({
      default: "Your code is {{ .Code }}",
      description: "The template to use for the SMS message.",
      tags,
      links: [links.auth],
    }),
    max_frequency: s.string({
      default: "60s",
      description:
        "Controls the minimum amount of time that must pass before sending another sms otp.",
      tags,
    }),
    twilio: s
      .strictObject({
        enabled: s.boolean({
          default: false,
          description: "Enable/disable Twilio provider for phone login.",
          tags,
          links: [links.phoneLogin("Twilio")],
        }),
        account_sid: s.string({
          description: "The account SID for the Twilio API.",
          tags,
          links: [links.phoneLogin("Twilio")],
        }),
        message_service_sid: s.string({
          description: "The message service SID for the Twilio API.",
          tags,
          links: [links.phoneLogin("Twilio")],
        }),
        auth_token: env({
          secret: true,
          description: "The auth token for the Twilio API.",
          tags,
          links: [links.phoneLogin("Twilio")],
        }),
      })
      .partial(),
    twilio_verify: s
      .strictObject({
        enabled: s.boolean({
          default: false,
          description: "Enable/disable Twilio Verify provider for phone verification.",
          tags,
          links: [links.phoneLogin("Twilio")],
        }),
        account_sid: s.string({
          description: "The account SID for the Twilio API.",
          tags,
          links: [links.phoneLogin("Twilio")],
        }),
        message_service_sid: s.string({
          description: "The message service SID for the Twilio API.",
          tags,
          links: [links.phoneLogin("Twilio")],
        }),
        auth_token: env({
          secret: true,
          description: "The auth token for the Twilio API.",
          tags,
          links: [links.phoneLogin("Twilio")],
        }),
      })
      .partial(),
    messagebird: s
      .strictObject({
        enabled: s.boolean({
          default: false,
          description: "Enable/disable MessageBird provider for phone login.",
          tags,
          links: [links.phoneLogin("MessageBird")],
        }),
        originator: s.string({
          description: "The originator of the SMS message.",
          tags,
          links: [links.phoneLogin("MessageBird")],
        }),
        api_key: env({
          secret: true,
          description: "The API key for the MessageBird API.",
          tags,
          links: [links.phoneLogin("MessageBird")],
        }),
      })
      .partial(),
    textlocal: s
      .strictObject({
        enabled: s.boolean({
          default: false,
          description: "Enable/disable Textlocal provider for phone login.",
          tags,
          links: [links.phoneLogin("Textlocal%2520(Community%2520Supported)")],
        }),
        sender: s.string({
          description: "The sender of the SMS message.",
          tags,
          links: [links.phoneLogin("Textlocal%2520(Community%2520Supported)")],
        }),
        api_key: env({
          secret: true,
          description: "The API key for the Textlocal API.",
          tags,
          links: [links.phoneLogin("Textlocal%2520(Community%2520Supported)")],
        }),
      })
      .partial(),
    vonage: s
      .strictObject({
        enabled: s.boolean({
          default: false,
          description: "Enable/disable Vonage provider for phone login.",
          tags,
          links: [links.phoneLogin("Vonage")],
        }),
        from: s.string({
          description: "The sender of the SMS message.",
          tags,
          links: [links.phoneLogin("Vonage")],
        }),
        api_key: env({
          secret: true,
          description: "The API key for the Vonage API.",
          tags,
          links: [links.phoneLogin("Vonage")],
        }),
        api_secret: env({
          secret: true,
          description: "The API secret for the Vonage API.",
          tags,
          links: [links.phoneLogin("Vonage")],
        }),
      })
      .partial(),
    test_otp: s.record(s.string(), {
      description: "Use pre-defined map of phone number to OTP for testing.",
      tags,
      links: [links.auth],
    }),
  })
  .partial();
