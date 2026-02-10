import { s } from "jsonv-ts";
import { email } from "./email.ts";
import { hook } from "./hooks.ts";
import { mfa } from "./mfa.ts";
import { external } from "./providers.ts";
import { sessions } from "./sessions.ts";
import { sms } from "./sms.ts";

const tags = ["auth"];

const links = {
  auth: {
    name: "Auth Server configuration",
    link: "https://supabase.com/docs/reference/auth",
  },
};

export const auth = s
  .strictObject({
    enabled: s.boolean({
      default: true,
      description: "Enable the local GoTrue service.",
      tags,
      links: [links.auth],
    }),
    site_url: s.string({
      default: "http://localhost:3000",
      description:
        "The base URL of your website. Used as an allow-list for redirects and for constructing URLs used in emails.",
      tags,
      links: [links.auth],
    }),
    additional_redirect_urls: s.array(
      s.string({
        description: "A URL that auth providers are permitted to redirect to.",
        tags,
      }),
      {
        default: ["https://localhost:3000"],
        description:
          "A list of _exact_ URLs that auth providers are permitted to redirect to post authentication.",
        tags,
        links: [links.auth],
      },
    ),
    jwt_expiry: s.number({
      default: 3600,
      description:
        "How long tokens are valid for, in seconds. Defaults to 3600 (1 hour), maximum 604,800 seconds (one week).",
      tags,
      links: [links.auth],
    }),
    enable_refresh_token_rotation: s.boolean({
      default: true,
      description: "If disabled, the refresh token will never expire.",
      tags,
      links: [links.auth],
    }),
    refresh_token_reuse_interval: s.number({
      default: 10,
      description:
        "Allows refresh tokens to be reused after expiry, up to the specified interval in seconds. Requires enable_refresh_token_rotation = true.",
      tags,
      links: [links.auth],
    }),
    enable_manual_linking: s.boolean({
      default: false,
      description: "Allow/disallow testing manual linking of accounts.",
      tags,
      links: [links.auth],
    }),
    enable_signup: s.boolean({
      default: true,
      description: "Allow/disallow new user signups to your project.",
      tags,
      links: [links.auth],
    }),
    enable_anonymous_sign_ins: s.boolean({
      default: false,
      description: "Allow/disallow anonymous sign-ins to your project.",
      tags,
      links: [links.auth],
    }),
    hook,
    mfa,
    sessions,
    email,
    sms,
    external,
  })
  .partial();
