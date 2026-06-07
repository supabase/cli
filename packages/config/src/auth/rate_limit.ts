import { Effect, Schema } from "effect";

const tags = ["auth"];

const links = [
  {
    name: "Auth Server configuration",
    link: "https://supabase.com/docs/reference/auth",
  },
];

const defaultRateLimit = {};
const defaultEmailSent = 2;
const defaultSmsSent = 30;
const defaultAnonymousUsers = 30;
const defaultTokenRefresh = 150;
const defaultSignInSignUps = 30;
const defaultTokenVerifications = 30;
const defaultWeb3 = 30;

export const rate_limit = Schema.Struct({
  email_sent: Schema.Number.annotate({
    default: defaultEmailSent,
    description: "Number of emails that can be sent per hour.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEmailSent))),
  sms_sent: Schema.Number.annotate({
    default: defaultSmsSent,
    description: "Number of SMS messages that can be sent per hour.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultSmsSent))),
  anonymous_users: Schema.Number.annotate({
    default: defaultAnonymousUsers,
    description: "Number of anonymous sign-ins that can be made per hour per IP address.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultAnonymousUsers))),
  token_refresh: Schema.Number.annotate({
    default: defaultTokenRefresh,
    description: "Number of sessions that can be refreshed in a 5 minute interval per IP address.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultTokenRefresh))),
  sign_in_sign_ups: Schema.Number.annotate({
    default: defaultSignInSignUps,
    description:
      "Number of sign up and sign-in requests that can be made in a 5 minute interval per IP address.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultSignInSignUps))),
  token_verifications: Schema.Number.annotate({
    default: defaultTokenVerifications,
    description:
      "Number of OTP or magic link verifications that can be made in a 5 minute interval per IP address.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultTokenVerifications))),
  web3: Schema.Number.annotate({
    default: defaultWeb3,
    description: "Number of Web3 logins that can be made in a 5 minute interval per IP address.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultWeb3))),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultRateLimit })));
