import type { CliProjectEnvironment, CliProjectPaths } from "@supabase/config";
import type { Option } from "effect";
import { Context } from "effect";

interface CliProjectContextShape {
  readonly paths: Option.Option<CliProjectPaths>;
  readonly projectEnv: Option.Option<CliProjectEnvironment>;
}

export class CliProjectContext extends Context.Service<CliProjectContext, CliProjectContextShape>()(
  "supabase/cli/CliProjectContext",
) {}
