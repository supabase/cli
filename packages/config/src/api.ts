import { Effect, Schema } from "effect";

const links = [
  {
    name: "PostgREST configuration",
    link: "https://postgrest.org/en/stable/configuration.html",
  },
];

const tags = ["api"];
const defaultApi = {};
const defaultEnabled = true;
const defaultPort = 54321;
const defaultSchemas = ["public", "graphql_public"];
const defaultExtraSearchPath = ["public", "extensions"];
const defaultMaxRows = 1000;
const defaultTls = {};
const defaultTlsEnabled = false;

export const api = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    default: defaultEnabled,
    description: "Enable the local PostgREST service.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEnabled))),
  port: Schema.Number.annotate({
    default: defaultPort,
    description: "Port to use for the API URL.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultPort))),
  schemas: Schema.Array(
    Schema.String.annotate({
      description:
        "Schemas to expose in your API. Tables, views and stored procedures in this schema will get API endpoints.",
      tags,
      links,
    }),
  )
    .annotate({ default: defaultSchemas })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([...defaultSchemas]))),
  extra_search_path: Schema.Array(
    Schema.String.annotate({
      description: "Extra schemas to add to the search_path of every request.",
      tags,
      links,
    }),
  )
    .annotate({ default: defaultExtraSearchPath })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([...defaultExtraSearchPath]))),
  max_rows: Schema.Number.annotate({
    default: defaultMaxRows,
    description:
      "The maximum number of rows returned from a view, table, or stored procedure. Limits payload size for accidental or malicious requests.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultMaxRows))),
  auto_expose_new_tables: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Controls whether newly-created tables, views, sequences and functions in the `public` schema by `postgres` are reachable through the Data API roles (`anon`, `authenticated`, `service_role`) without explicit GRANTs. When unset, new entities are not auto-exposed, matching the new cloud default (the implicit default flipped to `false` on 2026-05-30). Set to `true` to keep the legacy behaviour of auto-exposing new entities; this is deprecated and the field is removed on 2026-10-30 once the always-revoked behaviour is permanent. Set to `false` to pin the new default explicitly.",
      tags,
      links,
    }),
  ),
  tls: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultTlsEnabled,
      description: "Enable HTTPS endpoints locally using a self-signed certificate.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultTlsEnabled))),
    cert_path: Schema.optionalKey(
      Schema.String.annotate({
        description: "Path to the self-signed certificate.",
        tags,
        links,
      }),
    ),
    key_path: Schema.optionalKey(
      Schema.String.annotate({
        description: "Path to the self-signed certificate private key.",
        tags,
        links,
      }),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultTls }))),
  external_url: Schema.optionalKey(
    Schema.String.annotate({
      description: "External URL for accessing the API server.",
      tags,
    }),
  ),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultApi })));
