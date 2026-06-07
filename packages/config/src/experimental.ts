import { Effect, Schema } from "effect";
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

export const experimental = Schema.Struct({
  orioledb_version: Schema.optionalKey(
    Schema.String.annotate({
      description: "Postgres storage engine version for OrioleDB.",
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
