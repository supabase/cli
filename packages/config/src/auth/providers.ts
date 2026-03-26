import dedent from "dedent";
import { Schema } from "effect";
import { secret } from "../lib/env.ts";

const tags = ["auth"];

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

const provider = (providerConfig: {
  id: string;
  name: string;
  url?: {
    default?: string;
    examples?: string[];
  };
}) => {
  const links = [
    {
      name: `Login with ${providerConfig.name}`,
      link: `https://supabase.com/docs/guides/auth/social-login/auth-${providerConfig.id}`,
    },
  ];

  const defaultProvider = {};
  const defaultEnabled = false;
  const defaultClientId = "";
  const defaultUrl = providerConfig.url?.default ?? "";
  const defaultRedirectUri = "";
  const defaultSkipNonceCheck = false;
  const defaultEmailOptional = false;

  const schema = Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultEnabled,
      description: `Use the ${providerConfig.name} OAuth provider.`,
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultEnabled)),
    client_id: Schema.String.annotate({
      default: defaultClientId,
      description: `Client ID for the ${providerConfig.name} OAuth provider.`,
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultClientId)),
    secret: Schema.optionalKey(
      secret({
        examples: [`env(SUPABASE_AUTH_EXTERNAL_${providerConfig.id.toUpperCase()}_SECRET)`],
        description: dedent`
          Client secret for the ${providerConfig.name} OAuth provider.

          DO NOT commit your OAuth provider secret to git. Use environment variable substitution instead.
        `,
        tags,
        links,
      }),
    ),
    url: Schema.String.annotate({
      default: defaultUrl,
      description:
        "The base URL used for constructing the URLs to request authorization and access tokens.",
      ...providerConfig.url,
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultUrl)),
    redirect_uri: Schema.String.annotate({
      default: defaultRedirectUri,
      description: `The URI the ${providerConfig.name} OAuth2 provider will redirect to with the code and state values.`,
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultRedirectUri)),
    skip_nonce_check: Schema.Boolean.annotate({
      default: defaultSkipNonceCheck,
      description: "If true, the nonce check will be skipped.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultSkipNonceCheck)),
    email_optional: Schema.Boolean.annotate({
      default: defaultEmailOptional,
      description:
        "If true, authentication succeeds when the provider does not return an email address.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultEmailOptional)),
  });

  return schema
    .check(
      requiredWhenEnabled(
        "client_id",
        (value) => value.client_id !== "",
        `Missing required field in config: auth.external.${providerConfig.id}.client_id`,
      ),
      ...(providerConfig.id === "apple" || providerConfig.id === "google"
        ? []
        : [
            requiredWhenEnabled(
              "secret",
              (value) => value.secret !== undefined && value.secret !== "",
              `Missing required field in config: auth.external.${providerConfig.id}.secret`,
            ),
          ]),
    )
    .pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultProvider })));
};

const defaultExternal = {};

export const external = Schema.Struct({
  apple: provider({
    id: "apple",
    name: "Apple",
  }),
  azure: provider({
    id: "azure",
    name: "Azure",
  }),
  bitbucket: provider({
    id: "bitbucket",
    name: "Bitbucket",
  }),
  discord: provider({
    id: "discord",
    name: "Discord",
  }),
  facebook: provider({
    id: "facebook",
    name: "Facebook",
  }),
  github: provider({
    id: "github",
    name: "GitHub",
  }),
  gitlab: provider({
    id: "gitlab",
    name: "GitLab",
    url: {
      default: "https://gitlab.com",
    },
  }),
  google: provider({
    id: "google",
    name: "Google",
  }),
  kakao: provider({
    id: "kakao",
    name: "Kakao",
  }),
  keycloak: provider({
    id: "keycloak",
    name: "Keycloak",
    url: {
      examples: ["https://keycloak.example.com/realms/myrealm"],
    },
  }),
  linkedin_oidc: provider({
    id: "linkedin_oidc",
    name: "LinkedIn",
  }),
  notion: provider({
    id: "notion",
    name: "Notion",
  }),
  twitch: provider({
    id: "twitch",
    name: "Twitch",
  }),
  twitter: provider({
    id: "twitter",
    name: "Twitter",
  }),
  x: provider({
    id: "x",
    name: "X",
  }),
  slack: provider({
    id: "slack",
    name: "Slack",
  }),
  spotify: provider({
    id: "spotify",
    name: "Spotify",
  }),
  workos: provider({
    id: "workos",
    name: "WorkOS",
  }),
  zoom: provider({
    id: "zoom",
    name: "Zoom",
  }),
}).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultExternal })));
