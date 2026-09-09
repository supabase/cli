import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * Listing or reading migrations failed for a reason other than the directory
 * being absent. Byte-matches Go's `migration.ListLocalMigrations`
 * (`apps/cli-go/pkg/migration/list.go:34-37`), which returns
 * `"failed to read directory: " + err` for anything but `os.ErrNotExist` rather
 * than treating an unreadable `supabase/migrations` as "no migrations".
 *
 * Lives in `command-internal/` (not the `db`-command-scoped `pgdelta.errors`)
 * because it is raised by the shared migration-history module and consumed by
 * both the `db` and `migration` command families.
 */
export class MigrationsReadError extends Data.TaggedError("MigrationsReadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}
