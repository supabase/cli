import dedent from "dedent";
import { s } from "jsonv-ts";

const links = [
  {
    name: "Self-hosted Logflare Configuration",
    link: "https://supabase.com/docs/reference/self-hosting-analytics/list-endpoints#getting-started",
  },
];

const tags = ["analytics"];

export const analytics = s
  .strictObject({
    enabled: s.boolean({
      default: false,
      description: "Enable the local Logflare service.",
      tags,
      links,
    }),
    port: s.number({
      default: 54327,
      description: "Port to the local Logflare service.",
      tags,
    }),
    vector_port: s.number({
      default: 54328,
      description: "Port to the local syslog ingest service.",
      tags,
    }),
    backend: s.string({
      enum: ["postgres", "bigquery"],
      default: "postgres",
      description: dedent`
         Configure one of the supported backends:

         - \`postgres\`
         - \`bigquery\``,
      tags,
      links,
    }),
  })
  .partial();
