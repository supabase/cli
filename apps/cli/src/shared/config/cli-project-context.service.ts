import type { CliProjectEnvironment, CliProjectPaths } from "@supabase/config";
import type { Option } from "effect";
import { Context } from "effect";

interface CliProjectContextShape {
  readonly paths: Option.Option<CliProjectPaths>;
  /** Project `.env*` values only; a name the shell sets is never in here. */
  readonly projectEnv: Option.Option<Pick<CliProjectEnvironment, "values">>;
}

export class CliProjectContext extends Context.Service<CliProjectContext, CliProjectContextShape>()(
  "supabase/cli/CliProjectContext",
) {}
