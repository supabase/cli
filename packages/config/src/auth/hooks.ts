import { Effect, Schema } from "effect";
import { secret } from "../lib/env.ts";

const tags = ["auth"];

const link = (name: string, slug: string) => ({
  name,
  link: `https://supabase.com/docs/guides/auth/auth-hooks/${slug}`,
});

const defaultHook = {};
const defaultEnabled = false;

const createHookSchema = (name: string, slug: string) =>
  Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultEnabled,
      description: `Enable or disable the ${name.toLowerCase()}.`,
      tags,
      links: [link(name, slug)],
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEnabled))),
    uri: Schema.optionalKey(
      Schema.String.annotate({
        description: "The URI of the postgres function or HTTP endpoint to call.",
        tags,
        links: [link(name, slug)],
      }),
    ),
    secrets: Schema.optionalKey(
      secret({
        description: "Secret value to pass to the function or endpoint.",
        tags,
        links: [link(name, slug)],
      }),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultHook })));

export const hook = Schema.Struct({
  mfa_verification_attempt: createHookSchema("MFA Verification Hook", "mfa-verification-hook"),
  password_verification_attempt: createHookSchema(
    "Password Verification Hook",
    "password-verification-hook",
  ),
  custom_access_token: createHookSchema("Custom Access Token Hook", "custom-access-token-hook"),
  send_sms: createHookSchema("Send SMS Hook", "send-sms-hook"),
  send_email: createHookSchema("Send Email Hook", "send-email-hook"),
  before_user_created: createHookSchema("Before User Created Hook", "before-user-created-hook"),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultHook })));
