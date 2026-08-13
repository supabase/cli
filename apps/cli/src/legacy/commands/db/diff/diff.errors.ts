import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Conflicting database-target flags (`db-url`/`linked`/`local`); message text
 * is an established output contract.
 */
export class LegacyDbDiffTargetFlagsError extends Data.TaggedError("LegacyDbDiffTargetFlagsError")<{
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
export class LegacyDbDiffEngineConflictError extends Data.TaggedError(
  "LegacyDbDiffEngineConflictError",
)<{
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
export class LegacyDbDiffExplicitFlagsError extends Data.TaggedError(
  "LegacyDbDiffExplicitFlagsError",
)<{
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
export class LegacyDbDiffUnknownTargetError extends Data.TaggedError(
  "LegacyDbDiffUnknownTargetError",
)<{
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
export class LegacyDbDiffWriteError extends Data.TaggedError("LegacyDbDiffWriteError")<{
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
export class LegacyDbDiffDbNotRunningError extends Data.TaggedError(
  "LegacyDbDiffDbNotRunningError",
)<{
  readonly message: string;
  readonly daemonDown?: boolean;
  readonly suggestion?: string;
}> {
  // Must stay character-identical to `LegacyLocalDbRunningError`'s classification
  // (`legacy-db-bootstrap`'s equivalent local-db-not-running check) — the two are
  // deliberately duplicated for this command's own `AssertSupabaseDbIsRunning`
  // parity target, not shared, so keep them in sync by hand.
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.daemonDown === true
      ? { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" }
      : actionability.startStack; // same preset `reset-local-database.ts` uses
  }
}

/**
 * Classic "assertNever" exhaustiveness helper: with every literal of
 * `LegacyDbDiffPgAdminError["reason"]` handled by its own `case` below, `reason`
 * narrows to `never` by the time it reaches this call — so a FUTURE reason added
 * to the union without a matching `case` is a compile error here (its residual
 * type inside `default:` would no longer be `never`), not a silently-absorbed
 * classification. The parameter is intentionally unused at runtime: the drift
 * guard (`error-actionability-coverage.unit.test.ts`) evaluates every getter
 * against a field-less probe (`Object.create(prototype)`, no constructor args),
 * so `this.reason` is genuinely runtime-`undefined` there, bypassing the type
 * system entirely — this must still degrade to a valid declaration rather than
 * `undefined`/a crash, so it returns the SAME fallback as the "differ" case.
 */
function legacyPgAdminUnreachableReason(_reason: never): CliErrorActionabilityDeclaration {
  return actionability.dbFinding;
}

/**
 * The pgAdmin differ container failed to run, or its `--json-diff` output could
 * not be parsed. `reason` is a closed union set at the docker/parse boundary —
 * never inferred from `message` text.
 */
export class LegacyDbDiffPgAdminError extends Data.TaggedError("LegacyDbDiffPgAdminError")<{
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
      // user input mistake — same precedent as pg-delta's own malformed-subprocess-
      // output branch (`legacy-pgdelta.apply.ts`'s `"output_parse"` case).
      case "invalid_output":
        return { ...actionability.impossibleState, fingerprint_suffix: "invalid_content" };
      case "image_inspect":
        return { ...actionability.invalidConfig, fingerprint_suffix: "image_inspect" };
      // "differ": a failing container is the user's own schema/connection, matching
      // `LegacyMigraDiffError`'s default classification for the equivalent engine failure.
      case "differ":
        return actionability.dbFinding;
      default:
        return legacyPgAdminUnreachableReason(this.reason);
    }
  }
}
