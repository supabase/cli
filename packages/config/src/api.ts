import { Schema } from "effect";

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
const defaultAutoExposeNewTables = true;
const defaultTls = {};
const defaultTlsEnabled = false;

export const api = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    default: defaultEnabled,
    description: "Enable the local PostgREST service.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnabled)),
  port: Schema.Number.annotate({
    default: defaultPort,
    description: "Port to use for the API URL.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultPort)),
  schemas: Schema.Array(
    Schema.String.annotate({
      description:
        "Schemas to expose in your API. Tables, views and stored procedures in this schema will get API endpoints.",
      tags,
      links,
    }),
  )
    .annotate({ default: defaultSchemas })
    .pipe(Schema.withDecodingDefaultKey(() => [...defaultSchemas])),
  extra_search_path: Schema.Array(
    Schema.String.annotate({
      description: "Extra schemas to add to the search_path of every request.",
      tags,
      links,
    }),
  )
    .annotate({ default: defaultExtraSearchPath })
    .pipe(Schema.withDecodingDefaultKey(() => [...defaultExtraSearchPath])),
  max_rows: Schema.Number.annotate({
    default: defaultMaxRows,
    description:
      "The maximum number of rows returned from a view, table, or stored procedure. Limits payload size for accidental or malicious requests.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultMaxRows)),
  auto_expose_new_tables: Schema.Boolean.annotate({
    default: defaultAutoExposeNewTables,
    description:
      "When true (default), new tables, views, sequences and functions created in the `public` schema by `postgres` are automatically reachable through the Data API roles `anon`, `authenticated` and `service_role`. Set to false to match the new cloud default and require explicit GRANTs to expose entities through the Data API.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultAutoExposeNewTables)),
  tls: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultTlsEnabled,
      description: "Enable HTTPS endpoints locally using a self-signed certificate.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultTlsEnabled)),
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
  }).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultTls }))),
  external_url: Schema.optionalKey(
    Schema.String.annotate({
      description: "External URL for accessing the API server.",
      tags,
    }),
  ),
}).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultApi })));
