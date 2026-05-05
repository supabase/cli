import dedent from "dedent";
import { Schema } from "effect";
import { env } from "./lib/env.ts";

const tags = ["functions"];

const links = [
  {
    name: "`supabase functions` CLI subcommands",
    link: "https://supabase.com/docs/reference/cli/supabase-functions",
  },
];

const functionName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/));
const defaultEnabled = true;
const defaultVerifyJwt = true;
const defaultFunctions = {};
const defaultFunction = {};
const defaultImportMap = "";
const defaultEntrypoint = "";
const defaultStaticFiles: string[] = [];
const defaultEnv = {};
const envName = Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/));

const func = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    default: defaultEnabled,
    description: dedent`
      Controls whether a function is deployed or served.
    `,
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnabled)),
  verify_jwt: Schema.Boolean.annotate({
    default: defaultVerifyJwt,
    description: dedent`
      By default, deployed or locally served functions reject requests without a valid JWT.
    `,
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultVerifyJwt)),
  import_map: Schema.String.annotate({
    default: defaultImportMap,
    description: "Import map file to use for the Function.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultImportMap)),
  entrypoint: Schema.String.annotate({
    default: defaultEntrypoint,
    description: 'Entrypoint path to the Function. Defaults to "functions/slug/index.ts".',
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEntrypoint)),
  static_files: Schema.Array(
    Schema.String.annotate({
      description: "Static file glob for the function.",
      tags,
      links,
    }),
  )
    .annotate({
      default: defaultStaticFiles,
      description: "Static files to bundle with the function.",
      tags,
      links,
    })
    .pipe(Schema.withDecodingDefaultKey(() => [...defaultStaticFiles])),
  env: Schema.Record(
    envName.annotate({
      description: "Environment variable name exposed to the Function.",
      tags,
      links,
    }),
    env({
      description: "Reference to a project environment variable available to the Function.",
    }),
  )
    .annotate({
      default: defaultEnv,
      description:
        "Environment variables from the project environment that this Function can access.",
      tags,
      links,
    })
    .pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultEnv }))),
}).pipe(Schema.withDecodingDefault(() => ({ ...defaultFunction })));

export const functions = Schema.Record(functionName, func)
  .annotate({
    default: defaultFunctions,
    description: "Function-specific configuration keyed by function slug.",
    tags,
  })
  .pipe(Schema.withDecodingDefault(() => ({ ...defaultFunctions })));
