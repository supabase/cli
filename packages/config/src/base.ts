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
  experimental,
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));

/**
 * Exported separately (not inlined into {@link CliConfigSchema}) so
 * `packages/config/src/io.ts` can decode it on its own with
 * `disableChecks: true`. Go's `Config.Validate` only ever checks
 * `remotes.*.project_id` format for every remote block
 * (`apps/cli-go/pkg/config/config.go:996-1001`, "Since remote config is merged
 * to base, we only need to validate the project_id field") — every other
 * business-rule check (`Auth.External.validate()`, `Auth.Sms.validate()`,
 * etc.) runs exactly once, against the merged effective config
 * (`config.go:1136-1152`), never iterated over `c.Remotes[*]`. Decoding this
 * schema normally (checks enabled) would apply those same business-rule
 * `.check()`s — embedded in `auth`/`db`/etc. — to every remote regardless of
 * selection, rejecting configs Go accepts (e.g. an unselected
 * `[remotes.prod.auth.external.github] enabled = true` stub with no secret).
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
  const document = Schema.toJsonSchemaDocument(CliConfigSchema);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  };
}

export type CliConfig = typeof CliConfigSchema.Type;
export type CliConfigJson = typeof CliConfigSchema.Encoded;
