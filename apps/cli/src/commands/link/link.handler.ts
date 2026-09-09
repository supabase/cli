import { Effect } from "effect";
import { linkProject } from "../../command-internal/link-project.ts";

export const link = Effect.fn("link")(linkProject);
