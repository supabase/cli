import { Schema } from "effect";
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
}).pipe(Schema.withDecodingDefaultKey(() => ""));

const baseProjectConfigFields = {
  project_id: projectId,
  analytics,
  api,
  auth,
  db,
  edge_runtime,
  functions,
  inbucket,
  realtime,
  storage,
  studio,
  experimental,
};

const remoteProjectConfig = Schema.Struct({
  project_id: remoteProjectId,
  analytics,
  api,
  auth,
  db,
  edge_runtime,
  functions,
  inbucket,
  realtime,
  storage,
  studio,
  experimental,
}).pipe(Schema.withDecodingDefault(() => ({})));

export const ProjectConfigSchema = Schema.Struct({
  ...baseProjectConfigFields,
  remotes: Schema.Record(Schema.String, remoteProjectConfig)
    .annotate({
      default: {},
      description: "Remote branch-specific project configuration.",
      tags: ["general"],
    })
    .pipe(Schema.withDecodingDefault(() => ({}))),
});

export type ProjectConfig = typeof ProjectConfigSchema.Type;
export type ProjectConfigJson = typeof ProjectConfigSchema.Encoded;
