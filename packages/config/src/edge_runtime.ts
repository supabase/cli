import { Schema } from "effect";
import { secret } from "./lib/env.ts";
import { stringEnum } from "./lib/schema.ts";

const tags = ["edge-functions"];
const defaultEdgeRuntime = {};
const defaultEnabled = true;
const defaultPolicy = "per_worker";
const defaultInspectorPort = 8083;
const defaultDenoVersion = 2;

export const edge_runtime = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    default: defaultEnabled,
    description: "Enable the local Edge Runtime service.",
    tags,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnabled)),
  policy: stringEnum(["oneshot", "per_worker"], {
    default: defaultPolicy,
    description: "Configure the supported request policy.",
    tags,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultPolicy)),
  inspector_port: Schema.Number.annotate({
    default: defaultInspectorPort,
    description: "Port to run the Edge Functions inspector on.",
    tags,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultInspectorPort)),
  deno_version: Schema.Number.annotate({
    default: defaultDenoVersion,
    description: "The Deno major version to use.",
    tags,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultDenoVersion)),
  secrets: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      secret({
        description: "Secret value exposed to the edge runtime.",
        tags,
      }),
    ).annotate({
      description: "Secrets exposed to the edge runtime.",
      tags,
    }),
  ),
}).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultEdgeRuntime })));
