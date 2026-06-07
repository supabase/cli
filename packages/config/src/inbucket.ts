import dedent from "dedent";
import { Effect, Schema } from "effect";

const links = [
  {
    name: "Inbucket documentation",
    link: "https://www.inbucket.org",
  },
];

const tags = ["local"];
const defaultInbucket = {};
const defaultEnabled = true;
const defaultPort = 54324;

export const inbucket = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    default: defaultEnabled,
    description: "Enable the local Inbucket service.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEnabled))),
  port: Schema.Number.annotate({
    default: defaultPort,
    description: dedent`
      Port to use for the email testing server web interface.

      Emails sent with the local dev setup are monitored and available from the web interface.
    `,
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultPort))),
  smtp_port: Schema.optionalKey(
    Schema.Number.annotate({
      description: "Optional SMTP port to expose for local testing.",
      tags,
      links,
    }),
  ),
  pop3_port: Schema.optionalKey(
    Schema.Number.annotate({
      description: "Optional POP3 port to expose for local testing.",
      tags,
      links,
    }),
  ),
  admin_email: Schema.optionalKey(
    Schema.String.annotate({
      description: "Admin email address for test email sender metadata.",
      tags,
      links,
    }),
  ),
  sender_name: Schema.optionalKey(
    Schema.String.annotate({
      description: "Sender name for test email sender metadata.",
      tags,
      links,
    }),
  ),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultInbucket })));
