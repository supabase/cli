import { Data } from "effect";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  unclassifiedStackFailureActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

/** The start check that rejected the project or saved stack configuration. */
type StartConfigIssue =
  | "project-config"
  | "service-config"
  | "functions-env"
  | "saved-stack-changes"
  | "credentials-conflict"
  | "missing-database"
  | "missing-credentials";

const configIssueSuffix = {
  "project-config": "project_config",
  "service-config": "service_config",
  "functions-env": "functions_env",
  "saved-stack-changes": "saved_stack_changes",
  "credentials-conflict": "credentials_conflict",
  "missing-database": "missing_database",
  "missing-credentials": "missing_credentials",
} as const;

export class StackCommandStartError extends Data.TaggedError("ExperimentalStackStartError")<{
  readonly reason:
    | "invalid-config"
    | "filesystem"
    | "flags"
    | "runtime"
    | "lifecycle"
    | "seed"
    | "stack";
  readonly configIssue?: StartConfigIssue;
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "invalid-config":
        return {
          ...actionability.invalidConfig,
          fingerprint_suffix:
            this.configIssue === undefined ? "invalid_config" : configIssueSuffix[this.configIssue],
        };
      case "filesystem": {
        const declared = causeDeclaration(this.cause);
        return declared?.error_kind === "user_actionable"
          ? declared
          : { ...actionability.runtimeCrash, fingerprint_suffix: "filesystem_io" };
      }
      case "flags":
        return { ...actionability.provideFlags, fingerprint_suffix: "flags" };
      case "runtime":
        return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
      case "lifecycle":
        return { ...actionability.invalidConfig, fingerprint_suffix: "lifecycle" };
      case "seed":
        return { ...actionability.seedBuckets, fingerprint_suffix: "seed_buckets" };
      case "stack":
        return causeDeclaration(this.cause) ?? unclassifiedStackFailureActionability(this.cause);
    }
  }
}
