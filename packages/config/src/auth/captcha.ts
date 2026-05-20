import { Effect, Schema } from "effect";
import { secret } from "../lib/env.ts";
import { stringEnum } from "../lib/schema.ts";

const tags = ["auth"];

const links = [
  {
    name: "Auth Server configuration",
    link: "https://supabase.com/docs/reference/auth",
  },
];

const defaultCaptcha = {};
const defaultEnabled = false;

export const captcha = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    default: defaultEnabled,
    description: "Enable CAPTCHA verification.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEnabled))),
  provider: Schema.optionalKey(
    stringEnum(["hcaptcha", "turnstile"], {
      description: "CAPTCHA provider to use.",
      tags,
      links,
    }),
  ),
  secret: Schema.optionalKey(
    secret({
      description: "Secret key for the CAPTCHA provider.",
      tags,
      links,
    }),
  ),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultCaptcha })));
