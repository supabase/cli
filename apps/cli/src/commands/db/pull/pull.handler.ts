import { Effect } from "effect";
import { pullDatabaseSchema } from "../../../command-internal/db-pull.ts";

export const dbPull = Effect.fn("db.pull")(pullDatabaseSchema);
