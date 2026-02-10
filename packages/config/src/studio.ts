import { s } from "jsonv-ts";
import { env } from "./lib/env";

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

export const studio = s
  .strictObject({
    enabled: s.boolean({
      default: true,
      description: "Enable the local Supabase Studio dashboard.",
      tags,
      links: [links.studio],
    }),
    port: s.number({
      default: 54323,
      description: "Port to use for Supabase Studio.",
      tags,
    }),
    api_url: s.string({
      default: "http://localhost",
      description: "External URL of the API server that frontend connects to.",
      tags,
      links: [links.config],
    }),
    openai_api_key: env({
      secret: true,
      default: "env(OPENAI_API_KEY)",
      description: "OpenAI API key to use for Supabase AI in the Supabase Studio.",
      tags,
      links: [links.config],
    }),
  })
  .partial();
