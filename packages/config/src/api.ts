import { s } from "jsonv-ts";

const links = [
  {
    name: "PostgREST configuration",
    link: "https://postgrest.org/en/stable/configuration.html",
  },
];

const tags = ["api"];

export const api = s
  .strictObject({
    enabled: s.boolean({
      default: true,
      description: "Enable the local PostgREST service.",
      tags,
      links,
    }),
    port: s.number({
      default: 54321,
      description: "Port to use for the API URL.",
      tags,
      links,
    }),
    schemas: s.array(
      s.string({
        description:
          "Schemas to expose in your API. Tables, views and functions in this schema will get API endpoints. `public` and `storage` are always included.",
        tags,
        links,
      }),
      {
        default: ["public", "storage", "graphql_public"],
      },
    ),
    extra_search_path: s.array(
      s.string({
        description:
          "Extra schemas to add to the search_path of every request. public is always included.",
        tags,
        links,
      }),
      { default: ["public", "extensions"] },
    ),
    max_rows: s.number({
      default: 1000,
      description:
        "The maximum number of rows returned from a view, table, or stored procedure. Limits payload size for accidental or malicious requests.",
      tags,
      links,
    }),
    tls: s
      .strictObject({
        enabled: s.boolean({
          default: false,
          description: "Enable TLS for the local PostgREST service.",
          tags,
        }),
      })
      .partial(),
    external_url: s.string({
      default: "http://127.0.0.1:54321",
      description: "External URL for accessing the API server.",
      tags,
    }),
  })
  .partial();
