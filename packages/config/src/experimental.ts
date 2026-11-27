import { Effect, Schema, SchemaTransformation } from "effect";
import { secret } from "./lib/env.ts";

const tags = ["experimental"];
const defaultExperimental = {};

const inspectRule = Schema.Struct({
  query: Schema.optionalKey(
    Schema.String.annotate({
      description: "Inspection query.",
      tags,
    }),
  ),
  name: Schema.optionalKey(
    Schema.String.annotate({
      description: "Inspection rule name.",
      tags,
    }),
  ),
  pass: Schema.optionalKey(
    Schema.String.annotate({
      description: "Success message.",
      tags,
    }),
  ),
  fail: Schema.optionalKey(
    Schema.String.annotate({
      description: "Failure message.",
      tags,
    }),
  ),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({})));

/**
 * A feature gate written as `[experimental.<feature>] enabled = <bool>`. The bare boolean form
 * still decodes, to the same `{ enabled }` table.
 */
const featureGate = (enabledDescription: string) => {
  const table = Schema.Struct({
    enabled: Schema.optionalKey(Schema.Boolean.annotate({ description: enabledDescription, tags })),
  });
  return Schema.Union([
    Schema.Boolean.annotate({
      description: "Deprecated: set `enabled` in the table form instead.",
      tags,
    }),
    table,
  ]).pipe(
    Schema.decodeTo(
      table,
      SchemaTransformation.transform<typeof table.Encoded, boolean | typeof table.Type>({
        decode: (value) => (typeof value === "boolean" ? { enabled: value } : value),
        encode: (value) => value,
      }),
    ),
  );
};

export const experimental = Schema.Struct({
  compute: Schema.optionalKey(featureGate("Enable the experimental compute command family.")),
  stack: Schema.optionalKey(
    featureGate(
      "Use the new local stack backend for start, stop, and status, and for --local targets of the db, migration, test db, gen types, inspect, and pull command families.",
    ),
  ),
  orioledb_version: Schema.optionalKey(
    Schema.Literal("").annotate({
      description:
        "Removed: use `db.orioledb_version` instead. Only an empty value is accepted, for older generated config files.",
      tags,
    }),
  ),
  s3_host: Schema.optionalKey(
    Schema.String.annotate({
      description: "S3 bucket URL.",
      examples: ["<bucket_name>.s3-<region>.amazonaws.com", "env(S3_HOST)"],
      tags,
    }),
  ),
  s3_region: Schema.optionalKey(
    Schema.String.annotate({
      description: "S3 bucket region.",
      examples: ["us-east-1", "env(S3_REGION)"],
      tags,
    }),
  ),
  s3_access_key: Schema.optionalKey(
    secret({
      description: "S3 access key.",
      examples: ["env(S3_ACCESS_KEY)"],
      tags,
    }),
  ),
  s3_secret_key: Schema.optionalKey(
    secret({
      description: "S3 secret key.",
      examples: ["env(S3_SECRET_KEY)"],
      tags,
    }),
  ),
  webhooks: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Boolean.annotate({
        default: false,
        description: "Enable experimental webhooks.",
        tags,
      }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  ),
  pgdelta: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Boolean.annotate({
        default: true,
        description:
          "Use pg-delta as the schema diff engine for db diff / db pull (the default). Set false to fall back to the legacy migra engine.",
        tags,
      }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
      declarative_schema_path: Schema.optionalKey(
        Schema.String.annotate({
          description: "Directory under supabase/ where declarative schema files are written.",
          examples: ["./schemas"],
          tags,
        }),
      ),
      format_options: Schema.optionalKey(
        Schema.String.annotate({
          description:
            'JSON string passed through to pg-delta SQL formatting. When omitted, SQL is formatted with uppercase keywords, indent 2, max width 180, trailing commas, and column/key alignment. Set to "null" to emit raw, unformatted SQL.',
          examples: ['{"keywordCase":"upper","indent":2,"maxWidth":180,"commaStyle":"trailing"}'],
          tags,
        }),
      ),
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  ),
  inspect: Schema.optionalKey(
    Schema.Struct({
      rules: Schema.Array(inspectRule)
        .annotate({
          default: [],
          description: "Inspection rules.",
          tags,
        })
        .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  ),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultExperimental })));
