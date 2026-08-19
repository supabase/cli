import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

function SchemaCliError<Tag extends string>(tag: Tag) {
  return class extends Data.TaggedError(tag)<{
    readonly detail: string;
    readonly suggestion: string;
  }> {
    override get message() {
      return `${this.detail}\n  Suggestion: ${this.suggestion}`;
    }
  };
}

export class SchemaDeclarationsExistError extends SchemaCliError("SchemaDeclarationsExistError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class SchemaUnmanagedFilesError extends Data.TaggedError("SchemaUnmanagedFilesError")<{
  readonly detail: string;
  readonly suggestion: string;
  readonly paths: ReadonlyArray<string>;
}> {
  override get message() {
    return `${this.detail}\n  Suggestion: ${this.suggestion}`;
  }
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.invalidInput, fingerprint_suffix: "conflict" };
  }
}

export class SchemaWorkspaceIoError extends SchemaCliError("SchemaWorkspaceIoError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export class SchemaLockError extends SchemaCliError("SchemaLockError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export class SchemaCheckpointError extends SchemaCliError("SchemaCheckpointError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export class SchemaLocalStackNotRunningError extends SchemaCliError(
  "SchemaLocalStackNotRunningError",
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

export class SchemaLinkedConnectionError extends SchemaCliError("SchemaLinkedConnectionError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.projectNotLinked;
  }
}

export class SchemaDurableTargetError extends SchemaCliError("SchemaDurableTargetError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

export class SchemaDestructiveAuthError extends SchemaCliError("SchemaDestructiveAuthError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

export class SchemaProjectRefMismatchError extends SchemaCliError("SchemaProjectRefMismatchError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.missingProjectRef;
  }
}

export class SchemaAllowRemoteRequiredError extends SchemaCliError(
  "SchemaAllowRemoteRequiredError",
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

export class SchemaPlanningBlockedError extends SchemaCliError("SchemaPlanningBlockedError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

export class SchemaDeclarationsAheadError extends SchemaCliError("SchemaDeclarationsAheadError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.migrationDrift;
  }
}

export class SchemaRemoteDriftError extends SchemaCliError("SchemaRemoteDriftError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.migrationDrift;
  }
}

export class SchemaDraftConflictError extends SchemaCliError("SchemaDraftConflictError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.migrationDrift;
  }
}

export class SchemaEngineError extends SchemaCliError("SchemaEngineError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

export class SchemaPartialApplyError extends SchemaCliError("SchemaPartialApplyError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

export class SchemaMigrationNameError extends SchemaCliError("SchemaMigrationNameError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class SchemaHistoryConflictError extends SchemaCliError("SchemaHistoryConflictError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.migrationDrift;
  }
}

export class SchemaTargetRequiredError extends SchemaCliError("SchemaTargetRequiredError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class SchemaCancelledError extends SchemaCliError("SchemaCancelledError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}
