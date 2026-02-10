import { s } from "jsonv-ts";
import { env } from "./lib/env";

const tags = ["experimental"];

export const experimental = s
  .strictObject({
    orioledb_version: s.string({
      description: "Postgres storage engine to use OrioleDB (S3)",
      tags,
    }),
    s3_host: s.string({
      description: "S3 bucket URL.",
      examples: ["<bucket_name>.s3-<region>.amazonaws.com"],
      default: "env(S3_HOST)",
      tags,
    }),
    s3_region: s.string({
      description: "S3 bucket region.",
      examples: ["us-east-1"],
      default: "env(S3_REGION)",
      tags,
    }),
    s3_access_key: env({
      secret: true,
      description: "S3 access key.",
      default: "env(S3_ACCESS_KEY)",
      tags,
    }),
    s3_secret_key: env({
      secret: true,
      description: "S3 secret key.",
      default: "env(S3_SECRET_KEY)",
      tags,
    }),
  })
  .partial();
