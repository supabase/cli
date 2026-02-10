import dedent from "dedent";
import { s } from "jsonv-ts";
import { env } from "../lib/env";

const tags = ["auth"];

const provider = (provider: {
  id: string;
  name: string;
  url?: {
    default?: string;
    examples?: string[];
  };
}) => {
  const links = [
    {
      name: `Login with ${provider.name}`,
      link: `https://supabase.com/docs/guides/auth/social-login/auth-${provider.id}`,
    },
  ];

  return s
    .strictObject({
      enabled: s.boolean({
        default: false,
        description: `Use the ${provider.name} OAuth provider.`,
        tags,
        links,
      }),
      client_id: s.string({
        description: `Client ID for the ${provider.name} OAuth provider.`,
        tags,
        links,
      }),
      secret: env({
        secret: true,
        default: `env(SUPABASE_AUTH_EXTERNAL_${provider.id.toUpperCase()}_SECRET)`,
        description: dedent`
            Client secret for the ${provider.name} OAuth provider.

            DO NOT commit your OAuth provider secret to git. Use environment variable substitution instead.
         `,
        tags,
        links,
      }),
      url: s.string({
        description:
          "The base URL used for constructing the URLs to request authorization and access tokens.",
        ...provider.url,
        tags,
        links,
      }),
      redirect_uri: s.string({
        description: `The URI the ${provider.name} OAuth2 provider will redirect to with the code and state values.`,
        tags,
        links,
      }),
      skip_nonce_check: s.boolean({
        default: false,
        description: "If true, the nonce check will be skipped.",
        tags,
        links,
      }),
    })
    .partial();
};

export const external = s
  .strictObject({
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
      name: "Gitlab",
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
    linkedin: provider({
      id: "linkedin",
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
  })
  .partial();
