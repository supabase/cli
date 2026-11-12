import { Schema } from "effect";

import { make } from "../../../command-internal/command-facts/command-output.ts";
import { CommandTargetJson } from "../../../shared/output/command-target.service.ts";

/** The JSON result of `branches delete`. */
export const branchesDeleteOutput = make(
  Schema.Struct({
    project_ref: Schema.String.annotate({ description: "Project ref of the deleted branch." }),
    message: Schema.Literal("Deleted preview branch"),
    target: Schema.optionalKey(CommandTargetJson),
  }),
);
