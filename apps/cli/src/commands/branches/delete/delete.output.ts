import { Effect, Schema } from "effect";

import * as CommandOutput from "../../../command-internal/command-facts/command-output.ts";
import { Output } from "../../../shared/output/output.service.ts";

export const BranchDeleted = Schema.Struct({
  project_ref: Schema.String.annotate({ description: "Project ref of the deleted branch." }),
  message: Schema.Literal("Deleted preview branch"),
});
export interface BranchDeleted extends Schema.Schema.Type<typeof BranchDeleted> {}

export const branchesDeleteOutput = CommandOutput.make({
  schema: BranchDeleted,
  text: (deleted) =>
    Effect.gen(function* () {
      const output = yield* Output;
      yield* output.raw(`Deleted preview branch: ${deleted.project_ref}\n`, "stderr");
    }),
});
