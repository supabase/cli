import type { Effect } from "effect";
import { Context } from "effect";
import type {
  SchemaLinkedConnectionError,
  SchemaLocalStackNotRunningError,
  SchemaTargetRequiredError,
} from "../schema/schema-errors.ts";
import type { DatabaseTarget, DatabaseTargetSelector } from "./database-target.ts";

interface DatabaseTargetResolverShape {
  readonly resolve: (
    selector: DatabaseTargetSelector,
  ) => Effect.Effect<
    DatabaseTarget,
    SchemaLocalStackNotRunningError | SchemaLinkedConnectionError | SchemaTargetRequiredError
  >;
}

export class DatabaseTargetResolver extends Context.Service<
  DatabaseTargetResolver,
  DatabaseTargetResolverShape
>()("supabase/database/DatabaseTargetResolver") {}
