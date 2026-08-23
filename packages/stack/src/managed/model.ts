import { Data, Effect, Predicate } from "effect";
import type { ConfigPortKey, PortField } from "../PortCatalog.ts";
import { causeMessage } from "./failure.ts";

export const ORDINARY_WORKSPACE_IDENTITY_VERSION = 1;
export const GIT_CHECKOUT_IDENTITY_VERSION = 1;

export type ManagedPortIntent = "automatic" | "exact";

export interface OrdinaryWorkspaceIdentity {
  readonly version: typeof ORDINARY_WORKSPACE_IDENTITY_VERSION;
  readonly workspaceId: string;
  readonly checkoutId: string;
  readonly contextId: string;
}

export interface GitCheckoutIdentity {
  readonly version: typeof GIT_CHECKOUT_IDENTITY_VERSION;
  readonly checkoutId: string;
}

export interface ManagedStackPaths {
  readonly root: string;
  readonly data: string;
  readonly logs: string;
  readonly runtime: string;
}

export interface ManagedPortAssignment {
  readonly key: ConfigPortKey;
  readonly port: number;
  readonly intent: ManagedPortIntent;
}

export interface ManagedPortIntentDocument {
  readonly activeFields: ReadonlyArray<PortField>;
  /** Services omitted from activeFields but intentionally retaining prior intent. */
  readonly disabledFields?: ReadonlyArray<PortField>;
  readonly document?: Readonly<Record<string, unknown>>;
}

export type ManagedPortRequest =
  | {
      readonly field: PortField;
      readonly key: ConfigPortKey;
      readonly intent: "exact";
      readonly port: number;
    }
  | {
      readonly field: PortField;
      readonly key: ConfigPortKey;
      readonly intent: "automatic";
    };

export interface ManagedPortDrift {
  readonly key: ConfigPortKey;
  readonly actualIntent: ManagedPortIntent;
  readonly actualPort?: number;
  readonly configuredIntent: ManagedPortIntent;
  readonly configuredPort?: number;
}

export class InvalidManagedIdentityError extends Data.TaggedError("InvalidManagedIdentityError")<{
  readonly message: string;
}> {
  readonly code = "INVALID_MANAGED_IDENTITY" as const;
}

export class InvalidManagedStackNameError extends Data.TaggedError("InvalidManagedStackNameError")<{
  readonly name: string;
  readonly reason: "empty" | "control-character";
  readonly characterCode?: number;
}> {
  readonly code = "INVALID_MANAGED_STACK_NAME" as const;

  override get message(): string {
    if (this.reason === "empty") return "Managed stack name must not be empty";
    const code =
      this.characterCode === undefined
        ? "an"
        : `U+${this.characterCode.toString(16).toUpperCase().padStart(4, "0")}`;
    return `Managed stack name contains ASCII control character ${code}`;
  }
}

export const validateManagedStackName = (
  name: string,
): Effect.Effect<string, InvalidManagedStackNameError> => {
  if (name.length === 0) {
    return Effect.fail(new InvalidManagedStackNameError({ name, reason: "empty" }));
  }
  const character = Array.from(name).find((value) => {
    const code = value.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
  const characterCode = character?.codePointAt(0);
  if (characterCode !== undefined && (characterCode <= 0x1f || characterCode === 0x7f)) {
    return Effect.fail(
      new InvalidManagedStackNameError({ name, reason: "control-character", characterCode }),
    );
  }
  return Effect.succeed(name);
};

export class NoRunningStackError extends Data.TaggedError("NoRunningStackError")<{
  readonly cwd: string;
}> {}

export type UnsupportedGitWorkspaceCause =
  | "inside-git-directory"
  | "malformed-metadata"
  | "metadata-inaccessible"
  | "reftable";

export class UnsupportedGitWorkspaceError extends Data.TaggedError("UnsupportedGitWorkspaceError")<{
  readonly path: string;
  readonly reason: string;
  readonly workspaceCause: UnsupportedGitWorkspaceCause;
}> {
  readonly code = "UNSUPPORTED_GIT_WORKSPACE" as const;

  override get message(): string {
    return `${this.reason}: ${JSON.stringify(this.path)}`;
  }
}

export class ManagedExactPortOccupiedError extends Data.TaggedError(
  "ManagedExactPortOccupiedError",
)<{
  readonly key: ConfigPortKey;
  readonly port: number;
  readonly stackId: string;
  readonly ownerStackId?: string;
  readonly ownerStackName?: string;
  readonly ownerKey?: ConfigPortKey;
}> {
  readonly code = "MANAGED_EXACT_PORT_OCCUPIED" as const;

  override get message(): string {
    const owner = this.ownerStackId === undefined ? "another process" : this.ownerStackId;
    return `Port ${this.port} configured by ${this.key} is occupied by ${owner}`;
  }
}

export class ManagedPortAllocationError extends Data.TaggedError("ManagedPortAllocationError")<{
  readonly fields: ReadonlyArray<PortField>;
  readonly cause: unknown;
}> {
  readonly code = "MANAGED_PORT_ALLOCATION_FAILED" as const;

  override get message(): string {
    return `Failed to allocate managed ports ${this.fields.join(", ")}: ${causeMessage(this.cause)}`;
  }
}

export class ManagedStackNotFoundError extends Data.TaggedError("ManagedStackNotFoundError")<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_STACK_NOT_FOUND" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} was not found`;
  }
}

export class ManagedStackNotStoppedError extends Data.TaggedError("ManagedStackNotStoppedError")<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_STACK_NOT_STOPPED" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} must be safely stopped before deletion`;
  }
}

export class UnsafeManagedStackPathError extends Data.TaggedError("UnsafeManagedStackPathError")<{
  readonly path: string;
  readonly reason?: string;
}> {
  readonly code = "UNSAFE_MANAGED_STACK_PATH" as const;

  override get message(): string {
    return `${this.reason ?? "Refusing to remove an unsafe managed stack path"}: ${JSON.stringify(this.path)}`;
  }
}

export type ManagedStackError =
  | InvalidManagedIdentityError
  | InvalidManagedStackNameError
  | UnsupportedGitWorkspaceError
  | ManagedExactPortOccupiedError
  | ManagedPortAllocationError
  | ManagedStackNotFoundError
  | ManagedStackNotStoppedError
  | UnsafeManagedStackPathError;

export type ManagedErrorCode = ManagedStackError["code"];
export type ManagedErrorTag = ManagedStackError["_tag"];

function exhaustiveArrayOf<T extends string>() {
  return <U extends ReadonlyArray<T>>(array: U & ([T] extends [U[number]] ? unknown : never)): U =>
    array;
}

export const MANAGED_ERROR_CODES = exhaustiveArrayOf<ManagedErrorCode>()([
  "INVALID_MANAGED_IDENTITY",
  "INVALID_MANAGED_STACK_NAME",
  "UNSUPPORTED_GIT_WORKSPACE",
  "MANAGED_EXACT_PORT_OCCUPIED",
  "MANAGED_PORT_ALLOCATION_FAILED",
  "MANAGED_STACK_NOT_FOUND",
  "MANAGED_STACK_NOT_STOPPED",
  "UNSAFE_MANAGED_STACK_PATH",
] as const);

export const MANAGED_ERROR_TAG_BY_CODE = {
  INVALID_MANAGED_IDENTITY: "InvalidManagedIdentityError",
  INVALID_MANAGED_STACK_NAME: "InvalidManagedStackNameError",
  UNSUPPORTED_GIT_WORKSPACE: "UnsupportedGitWorkspaceError",
  MANAGED_EXACT_PORT_OCCUPIED: "ManagedExactPortOccupiedError",
  MANAGED_PORT_ALLOCATION_FAILED: "ManagedPortAllocationError",
  MANAGED_STACK_NOT_FOUND: "ManagedStackNotFoundError",
  MANAGED_STACK_NOT_STOPPED: "ManagedStackNotStoppedError",
  UNSAFE_MANAGED_STACK_PATH: "UnsafeManagedStackPathError",
} as const satisfies Record<ManagedErrorCode, ManagedErrorTag>;

const MANAGED_ERROR_TAGS: ReadonlySet<string> = new Set(Object.values(MANAGED_ERROR_TAG_BY_CODE));

export function isManagedStackError(error: unknown): error is ManagedStackError {
  if (!(error instanceof Error)) return false;
  return [...MANAGED_ERROR_TAGS].some((tag) => Predicate.isTagged(error, tag));
}
