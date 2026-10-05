import { Effect, Schema } from "effect";
import { analytics } from "./analytics.ts";
import { api } from "./api.ts";
import { auth } from "./auth/index.ts";
import { db } from "./db.ts";
import { edge_runtime } from "./edge_runtime.ts";
import { experimental } from "./experimental.ts";
import { functions } from "./functions.ts";
import { inbucket } from "./inbucket.ts";
import { realtime } from "./realtime.ts";
import { storage } from "./storage.ts";
import { studio } from "./studio.ts";
import { compute } from "./compute.ts";

const projectId = Schema.optionalKey(
  Schema.String.annotate({
    description:
      "A string used to distinguish different Supabase projects on the same host. Defaults to the working directory name when running `supabase init`.",
    tags: ["general"],
  }),
);

const remoteProjectId = Schema.String.annotate({
  default: "",
  description: "Remote project reference.",
  tags: ["general"],
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed("")));

const baseCliConfigFields = {
  project_id: projectId,
  analytics,
  api,
  auth,
  db,
  edge_runtime,
  functions,
  local_smtp: inbucket,
  realtime,
  storage,
  studio,
  compute,
  experimental,
};

const remoteCliConfigBlock = Schema.Struct({
  project_id: remoteProjectId,
  analytics,
  api,
  auth,
  db,
  edge_runtime,
  functions,
  local_smtp: inbucket,
  realtime,
  storage,
  studio,
  compute,
  experimental,
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));

/**
 * Exported separately (not inlined into {@link CliConfigSchema}) so
 * `packages/config/src/io.ts` can decode it on its own with
 * `disableChecks: true`. Only the merged effective config gets full
 * business-rule validation, never each remote block individually; decoding
 * this schema normally would apply those `.check()`s (embedded in
 * `auth`/`db`/etc.) to every remote regardless of selection, rejecting a valid
 * but unselected `[remotes.prod.auth.external.github] enabled = true` stub with
 * no secret.
 */
export const RemotesSchema = Schema.Record(Schema.String, remoteCliConfigBlock).annotate({
  default: {},
  description: "Remote branch-specific project configuration.",
  tags: ["general"],
});

export const CliConfigSchema = Schema.Struct({
  ...baseCliConfigFields,
  remotes: RemotesSchema.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});

export function toCliConfigJsonSchema() {
  const document = Schema.toJsonSchemaDocument(CliConfigSchema, { onExcessProperty: "error" });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  };
}

export type CliConfig = typeof CliConfigSchema.Type;
export type CliConfigJson = typeof CliConfigSchema.Encoded;
