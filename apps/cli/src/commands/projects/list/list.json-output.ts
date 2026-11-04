import { V1ProjectWithDatabaseResponse_Output } from "@supabase/api/effect";
import { Schema } from "effect";

/**
 * `projects list --output-format json` stdout. Projects are passed through from the Management API
 * response, so fields beyond the generated API schema can appear and are left open.
 */
export const ProjectsListJsonOutput = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      ...V1ProjectWithDatabaseResponse_Output.fields,
      linked: Schema.Boolean.annotate({
        description: "Whether this is the project linked to the current directory",
      }),
    }).annotate({ description: "A project the logged-in user can access" }),
  ),
  message: Schema.String.annotate({ description: "Always empty for this command" }),
});
