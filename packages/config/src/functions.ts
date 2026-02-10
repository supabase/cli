import * as s from "jsonv-ts";
import dedent from "dedent";
import { env } from "./lib/env";

const tags = ["functions"];

const links = [
  {
    name: "`supabase functions` CLI subcommands",
    link: "https://supabase.com/docs/reference/cli/supabase-functions",
  },
];

const func = s
  .strictObject({
    enabled: s.boolean({
      default: true,
      description: dedent`
         Controls whether a function is deployed or served. When set to false,
         the function will be skipped during deployment and won't be served locally.
         This is useful for disabling demo functions or temporarily disabling a function
         without removing its code.
      `,
      tags,
      links,
    }),
    verify_jwt: s.boolean({
      default: true,
      description: dedent`
         By default, when you deploy your Edge Functions or serve them locally, it
         will reject requests without a valid JWT in the Authorization header.
         Setting this configuration changes the default behavior.
      `,
      tags,
      links,
    }),
    import_map: s.string({
      description: dedent`
         Specify the Deno import map file to use for the Function.

         Note that the \`--import-map\` flag overrides this configuration.
      `,
      tags,
      links,
    }),
    entrypoint: s.string({
      description: dedent`
         Specify the entrypoint path to the Function (defaults to "functions/slug/index.ts").

         Both \`.js\` and \`.ts\` file extensions are supported.
      `,
      tags,
      links,
    }),
    env: s.record(
      env({
        description: dedent`
          An \`env()\` reference that resolves a variable from the current environment.
          Must follow the pattern \`env(VAR_NAME)\` where VAR_NAME is the source
          variable in the environment.
        `,
        tags,
        links,
      }),
      {
        description: dedent`
          Declares environment variables accessible to this function at runtime.

          Keys are the variable names the function sees via \`Deno.env.get()\`.
          Values must be \`env()\` references that resolve from the current environment.

          Functions can only access variables declared here plus the default
          Supabase platform variables (SUPABASE_URL, SUPABASE_ANON_KEY, etc.).
        `,
        examples: [
          {
            STRIPE_SECRET_KEY: "env(STRIPE_SECRET_KEY)",
            API_KEY: "env(OPENAI_API_KEY)",
          },
        ],
        tags,
        links,
      },
    ),
  })
  .partial();

export const functions = s.strictObject(
  {},
  {
    patternProperties: {
      "^[a-zA-Z0-9_-]+$": func,
    },
  },

  // pattern properties function is not supported at the moment
  // but this only matters for the types.
) as unknown as s.RecordSchema<typeof func>;
