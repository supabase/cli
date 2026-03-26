import { Schema } from "effect";
import { secret } from "../lib/env.ts";
import { stringEnum } from "../lib/schema.ts";
import { captcha } from "./captcha.ts";
import { email } from "./email.ts";
import { hook } from "./hooks.ts";
import { mfa } from "./mfa.ts";
import { external } from "./providers.ts";
import { rate_limit } from "./rate_limit.ts";
import { sessions } from "./sessions.ts";
import { sms } from "./sms.ts";
import { third_party } from "./third_party.ts";
import { web3 } from "./web3.ts";

const tags = ["auth"];

const links = {
  auth: {
    name: "Auth Server configuration",
    link: "https://supabase.com/docs/reference/auth",
  },
};

const defaultAuth = {};
const defaultEnabled = true;
const defaultSiteUrl = "http://127.0.0.1:3000";
const defaultAdditionalRedirectUrls = ["https://127.0.0.1:3000"];
const defaultJwtExpiry = 3600;
const defaultEnableRefreshTokenRotation = true;
const defaultRefreshTokenReuseInterval = 10;
const defaultEnableManualLinking = false;
const defaultEnableSignup = true;
const defaultEnableAnonymousSignIns = false;
const defaultMinimumPasswordLength = 6;
const defaultPasswordRequirements = "";
const defaultOAuthServer = {};
const defaultOAuthServerEnabled = false;
const defaultAuthorizationUrlPath = "/oauth/consent";
const defaultAllowDynamicRegistration = false;

export const auth = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    default: defaultEnabled,
    description: "Enable the local GoTrue service.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnabled)),
  site_url: Schema.String.annotate({
    default: defaultSiteUrl,
    description:
      "The base URL of your website. Used as an allow-list for redirects and for constructing URLs used in emails.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultSiteUrl)),
  additional_redirect_urls: Schema.Array(
    Schema.String.annotate({
      description: "A URL that auth providers are permitted to redirect to.",
      tags,
    }),
  )
    .annotate({
      default: defaultAdditionalRedirectUrls,
      description:
        "A list of exact URLs that auth providers are permitted to redirect to post authentication.",
      tags,
      links: [links.auth],
    })
    .pipe(Schema.withDecodingDefaultKey(() => [...defaultAdditionalRedirectUrls])),
  jwt_expiry: Schema.Number.annotate({
    default: defaultJwtExpiry,
    description:
      "How long tokens are valid for, in seconds. Defaults to 3600 (1 hour), maximum 604,800 seconds (one week).",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultJwtExpiry)),
  jwt_issuer: Schema.optionalKey(
    Schema.String.annotate({
      description: "JWT issuer URL.",
      tags,
      links: [links.auth],
    }),
  ),
  signing_keys_path: Schema.optionalKey(
    Schema.String.annotate({
      description: "Path to the JWT signing keys file.",
      tags,
      links: [links.auth],
    }),
  ),
  enable_refresh_token_rotation: Schema.Boolean.annotate({
    default: defaultEnableRefreshTokenRotation,
    description: "If disabled, the refresh token will never expire.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnableRefreshTokenRotation)),
  refresh_token_reuse_interval: Schema.Number.annotate({
    default: defaultRefreshTokenReuseInterval,
    description:
      "Allows refresh tokens to be reused after expiry, up to the specified interval in seconds.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultRefreshTokenReuseInterval)),
  enable_manual_linking: Schema.Boolean.annotate({
    default: defaultEnableManualLinking,
    description: "Allow/disallow testing manual linking of accounts.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnableManualLinking)),
  enable_signup: Schema.Boolean.annotate({
    default: defaultEnableSignup,
    description: "Allow/disallow new user signups to your project.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnableSignup)),
  enable_anonymous_sign_ins: Schema.Boolean.annotate({
    default: defaultEnableAnonymousSignIns,
    description: "Allow/disallow anonymous sign-ins to your project.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnableAnonymousSignIns)),
  minimum_password_length: Schema.Number.annotate({
    default: defaultMinimumPasswordLength,
    description: "Passwords shorter than this value will be rejected as weak.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultMinimumPasswordLength)),
  password_requirements: stringEnum(
    ["", "letters_digits", "lower_upper_letters_digits", "lower_upper_letters_digits_symbols"],
    {
      default: defaultPasswordRequirements,
      description: "Password character requirements.",
      tags,
      links: [links.auth],
    },
  ).pipe(Schema.withDecodingDefaultKey(() => defaultPasswordRequirements)),
  publishable_key: Schema.optionalKey(
    secret({
      description: "Publishable key override.",
      tags,
      links: [links.auth],
    }),
  ),
  secret_key: Schema.optionalKey(
    secret({
      description: "Secret key override.",
      tags,
      links: [links.auth],
    }),
  ),
  jwt_secret: Schema.optionalKey(
    secret({
      description: "JWT secret override.",
      tags,
      links: [links.auth],
    }),
  ),
  anon_key: Schema.optionalKey(
    secret({
      description: "Anon key override.",
      tags,
      links: [links.auth],
    }),
  ),
  service_role_key: Schema.optionalKey(
    secret({
      description: "Service role key override.",
      tags,
      links: [links.auth],
    }),
  ),
  rate_limit,
  captcha: Schema.optionalKey(captcha),
  hook,
  mfa,
  sessions: Schema.optionalKey(sessions),
  email,
  sms,
  external,
  web3,
  oauth_server: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultOAuthServerEnabled,
      description: "Enable OAuth server functionality.",
      tags,
      links: [links.auth],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultOAuthServerEnabled)),
    authorization_url_path: Schema.String.annotate({
      default: defaultAuthorizationUrlPath,
      description: "Path for OAuth consent flow UI.",
      tags,
      links: [links.auth],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultAuthorizationUrlPath)),
    allow_dynamic_registration: Schema.Boolean.annotate({
      default: defaultAllowDynamicRegistration,
      description: "Allow dynamic client registration.",
      tags,
      links: [links.auth],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultAllowDynamicRegistration)),
  }).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultOAuthServer }))),
  third_party,
}).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultAuth })));
