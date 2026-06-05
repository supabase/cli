import { Effect, Schema } from "effect";
import { secret } from "./lib/env.ts";

const links = {
  studio: {
    name: "Supabase Studio",
    link: "https://supabase.com/docs/guides/studio",
  },
  config: {
    name: "Supabase Studio Configuration",
    link: "https://supabase.com/docs/guides/self-hosting/studio",
  },
};

const tags = ["studio"];
const defaultStudio = {};
const defaultEnabled = true;
const defaultPort = 54323;
const defaultApiUrl = "http://127.0.0.1";

export const studio = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    default: defaultEnabled,
    description: "Enable the local Supabase Studio dashboard.",
    tags,
    links: [links.studio],
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEnabled))),
  port: Schema.Number.annotate({
    default: defaultPort,
    description: "Port to use for Supabase Studio.",
    tags,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultPort))),
  api_url: Schema.String.annotate({
    default: defaultApiUrl,
    description: "External URL of the API server that frontend connects to.",
    tags,
    links: [links.config],
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultApiUrl))),
  openai_api_key: Schema.optionalKey(
    secret({
      examples: ["env(OPENAI_API_KEY)"],
      description: "OpenAI API key to use for Supabase AI in the Supabase Studio.",
      tags,
      links: [links.config],
    }),
  ),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultStudio })));
