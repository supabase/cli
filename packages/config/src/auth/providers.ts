import dedent from "dedent";
import { Effect, Schema } from "effect";
import { secret } from "../lib/env.ts";
import { type CliConfigTableRuleIssue, tableRuleFilter } from "../lib/table-rule.ts";

const tags = ["auth"];

interface ExternalProviderInput {
  readonly enabled: boolean;
  readonly client_id: string;
  readonly secret?: string;
}

const secretOptional = (id: string) => id === "apple" || id === "google";

function providerRequirements(id: string) {
  return [
    ["client_id", (value: ExternalProviderInput) => value.client_id !== ""],
    ...(secretOptional(id)
      ? []
      : [
          [
            "secret",
            (value: ExternalProviderInput) => value.secret !== undefined && value.secret !== "",
          ] as const,
        ]),
  ] as const;
}

const providerRequirementFilter = (id: string, key: "client_id" | "secret") =>
  tableRuleFilter((value: ExternalProviderInput) =>
    cliConfigExternalProviderIssues(id, value, key),
  );

/** The required-when-enabled issues of the `[auth.external.<id>]` table; paths are relative to it. */
export function cliConfigExternalProviderIssues(
  id: string,
  value: ExternalProviderInput,
  only?: "client_id" | "secret",
): ReadonlyArray<CliConfigTableRuleIssue> {
  return providerRequirements(id).flatMap(([key, isPresent]) =>
    (only !== undefined && key !== only) || !value.enabled || isPresent(value)
      ? []
      : [{ path: [key], message: `Missing required field in config: auth.external.${id}.${key}` }],
  );
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
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEnabled))),
    client_id: Schema.String.annotate({
      default: defaultClientId,
      description: `Client ID for the ${providerConfig.name} OAuth provider.`,
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultClientId))),
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
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultUrl))),
    redirect_uri: Schema.String.annotate({
      default: defaultRedirectUri,
      description: `The URI the ${providerConfig.name} OAuth2 provider will redirect to with the code and state values.`,
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultRedirectUri))),
    skip_nonce_check: Schema.Boolean.annotate({
      default: defaultSkipNonceCheck,
      description: "If true, the nonce check will be skipped.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultSkipNonceCheck))),
    email_optional: Schema.Boolean.annotate({
      default: defaultEmailOptional,
      description:
        "If true, authentication succeeds when the provider does not return an email address.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEmailOptional))),
  });

  return schema
    .check(
      providerRequirementFilter(providerConfig.id, "client_id"),
      ...(secretOptional(providerConfig.id)
        ? []
        : [providerRequirementFilter(providerConfig.id, "secret")]),
    )
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultProvider })));
};

const defaultExternal = {};

/** OAuth providers. The removed `linkedin`/`slack` ids are rejected on load; use `linkedin_oidc`/`slack_oidc`. */
const externalProviders = Schema.Struct({
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
  figma: provider({
    id: "figma",
    name: "Figma",
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
  slack_oidc: provider({
    id: "slack_oidc",
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
});

/** The ids of the built-in providers, the only ones the schema's required-field rule covers. */
export const EXTERNAL_PROVIDER_IDS: ReadonlyArray<string> = Object.keys(externalProviders.fields);

export const external = externalProviders.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultExternal })),
);
