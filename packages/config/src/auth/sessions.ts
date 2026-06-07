import { Effect, Schema } from "effect";

const tags = ["auth"];

const links = [
  {
    name: "User sessions",
    link: "https://supabase.com/docs/guides/auth/sessions",
  },
];

const defaultSessions = {};

export const sessions = Schema.Struct({
  timebox: Schema.optionalKey(
    Schema.String.annotate({
      description: "The timebox for the user session.",
      tags,
      links,
    }),
  ),
  inactivity_timeout: Schema.optionalKey(
    Schema.String.annotate({
      description: "The inactivity timeout for the user session.",
      tags,
      links,
    }),
  ),
})
  .annotate({ default: defaultSessions })
  .pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultSessions })));
