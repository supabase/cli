import dedent from "dedent";
import { Effect, Schema } from "effect";
import { stringEnum } from "./lib/schema.ts";

const links = [
  {
    name: "Self-hosted Logflare Configuration",
    link: "https://supabase.com/docs/reference/self-hosting-analytics/list-endpoints#getting-started",
  },
];

const tags = ["analytics"];
const defaultAnalytics = {};
const defaultEnabled = true;
const defaultPort = 54327;
const defaultBackend = "postgres";

export const analytics = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    default: defaultEnabled,
    description: "Enable the local Logflare service.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEnabled))),
  port: Schema.Number.annotate({
    default: defaultPort,
    description: "Port to the local Logflare service.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultPort))),
  backend: stringEnum(["postgres", "bigquery"], {
    default: defaultBackend,
    description: dedent`
      Configure one of the supported backends:

      - \`postgres\`
      - \`bigquery\`
    `,
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultBackend))),
  vector_port: Schema.optionalKey(
    Schema.Number.annotate({
      description: "Port to the local syslog ingest service.",
      tags,
    }),
  ),
  gcp_project_id: Schema.optionalKey(
    Schema.String.annotate({
      description: "GCP project ID.",
      tags,
    }),
  ),
  gcp_project_number: Schema.optionalKey(
    Schema.String.annotate({
      description: "GCP project number.",
      tags,
    }),
  ),
  gcp_jwt_path: Schema.optionalKey(
    Schema.String.annotate({
      description: "Path to the GCP JWT file.",
      tags,
    }),
  ),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultAnalytics })));
