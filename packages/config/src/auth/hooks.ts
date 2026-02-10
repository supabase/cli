import { s } from "jsonv-ts";

const tags = ["auth"];

const link = (name: string, slug: string) => ({
  name,
  link: `https://supabase.com/docs/guides/auth/auth-hooks/${slug}`,
});

const createHookSchema = (name: string, slug: string) =>
  s
    .strictObject({
      enabled: s.boolean({
        default: false,
        description: `Enable/disable the ${name.toLowerCase()}.`,
        tags,
        links: [link(name, slug)],
      }),
      uri: s.string({
        description: "The URI of the postgres function or HTTP endpoint to call.",
        tags,
        links: [link(name, slug)],
      }),
      secrets: s.array(
        s.string({
          description: "A secret to pass to the function or endpoint.",
          tags,
        }),
        {
          description: "The secrets to pass to the postgres function or HTTP endpoint.",
          tags,
          links: [link(name, slug)],
        },
      ),
    })
    .partial();

export const hook = s
  .strictObject({
    mfa_verification_attempt: createHookSchema("MFA Verification Hook", "mfa-verification-hook"),
    password_verification_attempt: createHookSchema(
      "Password Verification Hook",
      "password-verification-hook",
    ),
    custom_access_token: createHookSchema("Custom Access Token Hook", "custom-access-token-hook"),
    send_sms: createHookSchema("Send SMS Hook", "send-sms-hook"),
    send_email: createHookSchema("Send Email Hook", "send-email-hook"),
  })
  .partial();
