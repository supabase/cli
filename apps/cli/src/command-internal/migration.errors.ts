import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * Listing or reading migrations failed for a reason other than the directory being absent
 * (e.g. a permissions error) — an unreadable `supabase/migrations` is not treated as "no
 * migrations". Shared by both the `db` and `migration` command families.
 */
export class MigrationsReadError extends Data.TaggedError("MigrationsReadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}
