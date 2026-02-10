import * as s from "jsonv-ts";

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

declare module "jsonv-ts" {
  interface ISchemaOptions {
    tags?: string[];
    links?: {
      name: string;
      link: string;
    }[];
  }
}

export const schema = s
  .strictObject({
    project_id: s.string({
      description:
        "A string used to distinguish different Supabase projects on the same host. Defaults to the working directory name when running `supabase init`.",
      tags: ["general"],
    }),
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
  })
  .partial();
