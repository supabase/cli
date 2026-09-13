import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Conflicting database-target flags (`db-url`/`linked`/`local`); message text
 * is an established output contract.
 */
export class DbDiffTargetFlagsError extends Data.TaggedError("DbDiffTargetFlagsError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Conflicting diff-engine flags (`use-migra`/`use-pgadmin`/`use-pg-schema`/
 * `use-pg-delta`); message text is an established output contract.
 */
export class DbDiffEngineConflictError extends Data.TaggedError("DbDiffEngineConflictError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Only one of `--from` / `--to` was set in explicit diff mode; message text is
 * an established output contract.
 */
export class DbDiffExplicitFlagsError extends Data.TaggedError("DbDiffExplicitFlagsError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * An explicit `--from`/`--to` ref was neither `local`/`linked`/`migrations` nor a
 * postgres URL; message text is an established output contract.
 */
export class DbDiffUnknownTargetError extends Data.TaggedError("DbDiffUnknownTargetError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Writing the diff output failed — a `--file` migration, or an explicit-mode
 * `--output` file.
 */
export class DbDiffWriteError extends Data.TaggedError("DbDiffWriteError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * The local database container is not running, or inspecting it failed. Unlike
 * every other engine on this command, `--use-pgadmin` runs this check even for
 * `--linked`/`--db-url` — see `diff.handler.ts`'s pgadmin branch.
 */
export class DbDiffDbNotRunningError extends Data.TaggedError("DbDiffDbNotRunningError")<{
  readonly message: string;
  readonly daemonDown?: boolean;
  readonly suggestion?: string;
}> {
  // Must stay character-identical to `LocalDbRunningError`'s classification
  // (`legacy-db-bootstrap`'s equivalent local-db-not-running check). The two are kept in sync by
  // hand rather than shared, since they serve separate parity targets.
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.daemonDown === true
      ? { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" }
      : actionability.startStack; // same preset `reset-local-database.ts` uses
  }
}

/**
 * Exhaustiveness helper: with every literal of `DbDiffPgAdminError["reason"]` handled by its own
 * `case` below, `reason` narrows to `never` here — so a new reason added to the union without a
 * matching `case` is a compile error, not a silently-absorbed classification.
 *
 * The drift guard (`error-actionability-coverage.unit.test.ts`) evaluates every getter against a
 * field-less probe, so `this.reason` is genuinely `undefined` at runtime here; this must still
 * return a valid declaration rather than crash, so it falls back to the "differ" case's value.
 */
function pgAdminUnreachableReason(_reason: never): CliErrorActionabilityDeclaration {
  return actionability.dbFinding;
}

/**
 * The pgAdmin differ container failed to run, or its `--json-diff` output could
 * not be parsed. `reason` is a closed union set at the docker/parse boundary —
 * never inferred from `message` text.
 */
export class DbDiffPgAdminError extends Data.TaggedError("DbDiffPgAdminError")<{
  readonly message: string;
  readonly reason:
    | "differ"
    | "invalid_output"
    | "docker_daemon"
    | "registry_pull"
    | "image_inspect";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "docker_daemon":
        return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
      case "registry_pull":
        return { ...actionability.externalNetwork, fingerprint_suffix: "registry_pull" };
      // Malformed pinned-differ wire output is an internal contract violation, not a
      // user input mistake — same classification as pg-delta's own malformed-output
      // failures (`PgDeltaEngineError` with `reason: "output_parse"`).
      case "invalid_output":
        return { ...actionability.impossibleState, fingerprint_suffix: "invalid_content" };
      case "image_inspect":
        return { ...actionability.invalidConfig, fingerprint_suffix: "image_inspect" };
      // "differ": a failing container is the user's own schema/connection, matching
      // `MigraDiffError`'s default classification for the equivalent engine failure.
      case "differ":
        return actionability.dbFinding;
      default:
        return pgAdminUnreachableReason(this.reason);
    }
  }
}
