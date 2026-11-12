import { Schema } from "effect";

import { make } from "../../../command-internal/command-facts/command-output.ts";

/** The JSON result of `branches delete`. */
export const branchesDeleteOutput = make(
  Schema.Struct({
    project_ref: Schema.String.annotate({ description: "Project ref of the deleted branch." }),
    message: Schema.Literal("Deleted preview branch"),
  }),
);
