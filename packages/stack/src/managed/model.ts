import { Data } from "effect";
import type { ConfigPortKey, PortField } from "../PortCatalog.ts";

export const ORDINARY_WORKSPACE_IDENTITY_VERSION = 1;
export const GIT_CHECKOUT_IDENTITY_VERSION = 1;
export const DEFAULT_MANAGED_STACK_NAME = "default";

export type ManagedRuntimeRequest = "auto" | "docker" | "native";
export type ManagedRuntime = "docker" | "native";

/**
 * What a registered checkout physically is. A primary git checkout is `git`;
 * `linked-worktree` and `bare-worktree` are the two kinds of linked worktree,
 * distinguished by whether the repository they belong to has a working tree of
 * its own; `ordinary` is a folder outside any repository.
 *
 * Recorded because it is the only thing that explains a checkout's identity
 * locations to a reader, never because identity depends on it: every checkout,
 * worktrees included, is keyed by its own opaque UUID.
 */
export type ManagedCheckoutKind = "bare-worktree" | "git" | "linked-worktree" | "ordinary";

/**
 * What a development context is keyed by, which decides its scope:
 *
 * - `branch` contexts are project-scoped, because a branch is shared by every
 *   checkout of the repository and two worktrees on one branch resolve one
 *   context. Their IDs are minted in git config, so git's own rules rename and
 *   delete them along with the branch.
 * - `detached` contexts are checkout-scoped: a detached `HEAD` names no branch,
 *   so every commit a checkout is parked on shares that checkout's one detached
 *   context rather than minting a context per commit.
 * - `workspace` contexts are the ordinary-folder case, checkout-scoped and
 *   recorded in the folder's own identity marker.
 */
export type ManagedContextKind = "branch" | "detached" | "workspace";

/** The checkout-scoped context kinds, of which a checkout has at most one each. */
export type ManagedCheckoutScopedContextKind = Exclude<ManagedContextKind, "branch">;

/**
 * How a caller names the context a stack belongs to. A branch carries its name
 * as a display-only locator; the other two are keyed by the checkout alone.
 */
export type ManagedContextDescriptor =
  | { readonly kind: "branch"; readonly locator: string }
  | { readonly kind: "detached" }
  | { readonly kind: "workspace" };
export type ManagedStackStatus = "active" | "pending" | "tombstoned";
export type ManagedStackLifecycle = "failed" | "running" | "starting" | "stopped" | "stopping";
export type ManagedPortIntent = "automatic" | "exact";
export type ManagedPortSource = "environment" | "local" | "omitted" | "remote";
export type ManagedOperationKind = "delete" | "start" | "stop" | "update";
export type ManagedOperationStatus = "active" | "completed" | "failed";

export interface OrdinaryWorkspaceIdentity {
  readonly version: typeof ORDINARY_WORKSPACE_IDENTITY_VERSION;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly contextId: string;
}

/**
 * The checkout identity a git checkout keeps inside its own git directory.
 *
 * The project and branch-context identities live in git config, where git's own
 * lifecycle rules apply to them: the common config is shared by every linked
 * worktree and is never copied by `git clone`, and git renames or deletes a
 * `branch.<name>` section along with the branch. A checkout identity has no such
 * rule to inherit — it must be per-worktree — so it is stored as a file, one per
 * git directory.
 */
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
  readonly document?: Readonly<Record<string, unknown>>;
  readonly valueOrigins?: ReadonlyArray<{
    readonly path: ReadonlyArray<string>;
    readonly source: Exclude<ManagedPortSource, "omitted">;
  }>;
}

export type ManagedPortRequest =
  | {
      readonly field: PortField;
      readonly key: ConfigPortKey;
      readonly intent: "exact";
      readonly port: number;
      readonly source: Exclude<ManagedPortSource, "omitted">;
    }
  | {
      readonly field: PortField;
      readonly key: ConfigPortKey;
      readonly intent: "automatic";
      readonly source: "omitted";
    };

export interface ManagedPortDrift {
  readonly key: ConfigPortKey;
  readonly actualIntent: ManagedPortIntent;
  readonly actualPort: number;
  readonly configuredIntent: ManagedPortIntent;
  readonly configuredPort?: number;
}

export interface ManagedRuntimeMetadata {
  readonly pid?: number;
  readonly socketPath?: string;
  readonly processIds: Readonly<Record<string, number>>;
  readonly containerIds: Readonly<Record<string, string>>;
}

export interface ManagedStackRecord {
  readonly id: string;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly contextId: string;
  readonly name: string;
  readonly status: ManagedStackStatus;
  readonly lifecycle: ManagedStackLifecycle;
  readonly runtimeRequest: ManagedRuntimeRequest;
  readonly runtime?: ManagedRuntime;
  readonly paths: ManagedStackPaths;
  readonly ports: ReadonlyArray<ManagedPortAssignment>;
  readonly serviceVersions: Readonly<Record<string, string>>;
  readonly runtimeMetadata: ManagedRuntimeMetadata;
  readonly configFingerprint?: string;
  readonly credentialsReference?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tombstonedAt?: string;
}

/**
 * A stack record joined to the checkout and context it belongs to, so a reader
 * can tell sibling instances apart without resolving any workspace: two stacks
 * of the same name differ by their checkout, and two checkouts of one repository
 * differ by their canonical path.
 *
 * The joined fields are reported rather than authoritative — a canonical path is
 * absent once its checkout location has been pruned, and a branch locator is
 * whatever the branch was called when the context was last resolved — so nothing
 * may key a decision on them.
 */
export interface ManagedStackProjection extends ManagedStackRecord {
  readonly checkoutKind: ManagedCheckoutKind;
  readonly canonicalPath?: string;
  readonly contextKind: ManagedContextKind;
  readonly contextLocator?: string;
}

/** The complete identity a stack is resolved by, before the stack itself. */
export interface ManagedIdentityTriple {
  readonly projectId: string;
  readonly checkoutId: string;
  readonly contextId: string;
}

export interface ManagedContextRecord {
  readonly id: string;
  readonly projectId: string;
  /** Absent for a branch context, which is shared by the whole project. */
  readonly checkoutId?: string;
  readonly kind: ManagedContextKind;
  /** The branch name a branch context was last resolved under; display-only. */
  readonly locator?: string;
  /** Authoritative branch owner; locator is display-only and may be refreshed. */
  readonly ownerBranch?: string;
  readonly createdAt: string;
}

export interface ManagedOperationRecord {
  readonly token: string;
  readonly stackId: string;
  readonly kind: ManagedOperationKind;
  readonly status: ManagedOperationStatus;
  readonly ownerPid?: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
}

export interface ManagedCheckoutLocation {
  readonly id: string;
  readonly checkoutId: string;
  readonly canonicalPath: string;
  readonly state: ManagedCheckoutLocationState;
  readonly reboundFromLocationId?: string;
  readonly lastSeenAt: string;
}

export type ManagedCheckoutLocationState = "active" | "blocked" | "superseded";

export type ManagedIdentityTransitionKind =
  | "adopt-context"
  | "branch-copy"
  | "folder-to-git"
  | "new-checkout"
  | "rebind-checkout";

export type ManagedIdentityTransitionPhase = "finalized" | "git-written" | "reserved";

export interface ManagedIdentityTransitionRecord {
  readonly id: string;
  readonly kind: ManagedIdentityTransitionKind;
  readonly phase: ManagedIdentityTransitionPhase;
  readonly projectId?: string;
  readonly checkoutId?: string;
  readonly contextId?: string;
  readonly branch?: string;
  readonly path?: string;
  /** Storage location shared by every checkout that reads the same project identity. */
  readonly projectIdentityLocation?: string;
  readonly expectedGitValue?: string;
  readonly targetGitValue?: string;
  /** Previous branch owner that an adopt-context transition is allowed to replace. */
  readonly expectedOwnerBranch?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedIdentityClaims {
  /** Authoritative project ownership for checkout-scoped claims in this snapshot. */
  readonly checkoutProjects: ReadonlyArray<{
    readonly checkoutId: string;
    readonly projectId: string;
  }>;
  readonly locations: ReadonlyArray<ManagedCheckoutLocation>;
  readonly contexts: ReadonlyArray<ManagedContextRecord>;
  readonly transitions: ReadonlyArray<ManagedIdentityTransitionRecord>;
}

export interface ManagedStackConfiguration {
  readonly runtimeRequest?: ManagedRuntimeRequest;
  readonly runtime?: ManagedRuntime;
  readonly ports?: ReadonlyArray<ManagedPortAssignment>;
  readonly serviceVersions?: Readonly<Record<string, string>>;
  readonly runtimeMetadata?: ManagedRuntimeMetadata;
  readonly lifecycle?: ManagedStackLifecycle;
  readonly configFingerprint?: string;
  readonly credentialsReference?: string;
}

export interface ManagedStackSelection {
  readonly projectId: string;
  readonly checkoutId: string;
  readonly contextId: string;
  readonly stackId: string;
  readonly stackName: string;
}

export class InvalidManagedIdentityError extends Data.TaggedError("InvalidManagedIdentityError")<{
  readonly message: string;
}> {
  readonly code = "INVALID_MANAGED_IDENTITY" as const;
}

/**
 * The registry file opened successfully, but its load-bearing SQLite schema is
 * not the shape this runtime was built to use. This is a caller-actionable
 * incompatibility, distinct from driver corruption or an I/O defect.
 */
export class IncompatibleManagedRegistryError extends Data.TaggedError(
  "IncompatibleManagedRegistryError",
)<{
  readonly reason: string;
}> {
  readonly code = "INCOMPATIBLE_MANAGED_REGISTRY" as const;

  override get message(): string {
    return `Managed registry schema is incompatible: ${this.reason}`;
  }
}

/**
 * The closed set of materially different reasons {@link UnsupportedGitWorkspaceError}
 * is raised for, so telemetry can fingerprint them separately instead of
 * collapsing every refusal into one bucket:
 *
 * - `inside-git-directory` — the path itself is git metadata (a bare
 *   repository's directory, or a `.git` directory), not a working tree.
 * - `malformed-metadata` — the path is a checkout, but its git metadata
 *   (`.git` link target, `HEAD`, or the ref `HEAD` names) cannot be read or
 *   makes no sense.
 * - `metadata-inaccessible` — the metadata exists or was expected to exist,
 *   but the host filesystem or git config command refused access to it.
 * - `reftable` — the repository's refs are stored in a reftable, which this
 *   package does not read yet.
 */
export type UnsupportedGitWorkspaceCause =
  | "inside-git-directory"
  | "malformed-metadata"
  | "metadata-inaccessible"
  | "reftable";

/**
 * A path that encloses git metadata rather than a working tree: a bare
 * repository's directory, a `.git` directory, or a checkout whose `HEAD` names
 * something no branch context can be derived from.
 *
 * Refused rather than guessed at, because every alternative invents an identity
 * for a workspace that has none: a bare repository has no working tree to run a
 * stack against, and the linked worktrees that do belong to it are inspected
 * from their own paths.
 */
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

export class DuplicateManagedIdentityError extends Data.TaggedError(
  "DuplicateManagedIdentityError",
)<{
  readonly identityId: string;
  readonly existingClaim: string;
  readonly requestedClaim: string;
}> {
  readonly code = "DUPLICATE_MANAGED_IDENTITY" as const;

  override get message(): string {
    return `Managed identity ${this.identityId} is already claimed by ${this.existingClaim}; refusing a second claim from ${this.requestedClaim}`;
  }
}

export class ManagedCheckoutConflictError extends Data.TaggedError("ManagedCheckoutConflictError")<{
  readonly checkoutId: string;
  readonly canonicalPath: string;
  readonly existingCheckoutId?: string;
}> {
  readonly code = "MANAGED_CHECKOUT_CONFLICT" as const;

  override get message(): string {
    return `Managed checkout path ${this.canonicalPath} conflicts with ${this.existingCheckoutId ?? "another claim"}`;
  }
}

export class ManagedInaccessiblePathError extends Data.TaggedError("ManagedInaccessiblePathError")<{
  readonly path: string;
}> {
  readonly code = "MANAGED_INACCESSIBLE_PATH" as const;

  override get message(): string {
    return `Managed checkout path is inaccessible: ${JSON.stringify(this.path)}`;
  }
}

export class ManagedCopiedBranchConflictError extends Data.TaggedError(
  "ManagedCopiedBranchConflictError",
)<{
  readonly branch: string;
  readonly existingContextId?: string;
  readonly requestedContextId?: string;
}> {
  readonly code = "MANAGED_COPIED_BRANCH_CONFLICT" as const;

  override get message(): string {
    return `Copied branch ${this.branch} conflicts with existing managed context`;
  }
}

export class ManagedIdentityTransitionOwnershipError extends Data.TaggedError(
  "ManagedIdentityTransitionOwnershipError",
)<{
  readonly transitionId: string;
  readonly resource?: string;
}> {
  readonly code = "MANAGED_IDENTITY_TRANSITION_OWNERSHIP" as const;

  override get message(): string {
    return `Identity transition ${this.transitionId} is owned by another transition`;
  }
}

export class DuplicateManagedPortKeyError extends Data.TaggedError("DuplicateManagedPortKeyError")<{
  readonly key: string;
}> {
  readonly code = "MANAGED_DUPLICATE_PORT_KEY" as const;

  override get message(): string {
    return `Duplicate managed port key ${this.key}`;
  }
}

export class InvalidManagedStackNameError extends Data.TaggedError("InvalidManagedStackNameError")<{
  readonly stackName: string;
}> {
  readonly code = "MANAGED_INVALID_STACK_NAME" as const;

  override get message(): string {
    return `Invalid managed stack name: ${this.stackName}`;
  }
}

export class InvalidManagedOwnerPidError extends Data.TaggedError("InvalidManagedOwnerPidError")<{
  readonly ownerPid: number;
}> {
  readonly code = "MANAGED_INVALID_OWNER_PID" as const;

  override get message(): string {
    return `Invalid managed operation owner pid ${this.ownerPid}`;
  }
}

export class InvalidManagedPortError extends Data.TaggedError("InvalidManagedPortError")<{
  readonly port: number;
  readonly key: string;
}> {
  readonly code = "MANAGED_INVALID_PORT" as const;

  override get message(): string {
    return `Invalid managed port ${this.port} for ${this.key}`;
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

export class ManagedPendingStackUpdateError extends Data.TaggedError(
  "ManagedPendingStackUpdateError",
)<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_PENDING_STACK_UPDATE" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} is still pending publication and cannot be reconfigured through an update`;
  }
}

export class ManagedOperationInProgressError extends Data.TaggedError(
  "ManagedOperationInProgressError",
)<{
  readonly stackId: string;
  readonly operation: ManagedOperationRecord;
}> {
  readonly code = "MANAGED_OPERATION_IN_PROGRESS" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} already has an active ${this.operation.kind} operation`;
  }
}

export class ManagedOperationOwnershipError extends Data.TaggedError(
  "ManagedOperationOwnershipError",
)<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_OPERATION_OWNERSHIP_MISMATCH" as const;

  override get message(): string {
    return `The active operation for managed stack ${this.stackId} is owned by another caller`;
  }
}

export class ManagedPortReservationError extends Data.TaggedError("ManagedPortReservationError")<{
  readonly port: number;
  readonly ownerStackId: string;
}> {
  readonly code = "MANAGED_PORT_ALREADY_RESERVED" as const;

  override get message(): string {
    return `Port ${this.port} is already reserved by managed stack ${this.ownerStackId}`;
  }
}

export class ManagedExactPortOccupiedError extends Data.TaggedError(
  "ManagedExactPortOccupiedError",
)<{
  readonly key: ConfigPortKey;
  readonly port: number;
  readonly ownerStackId?: string;
  readonly ownerStackName?: string;
}> {
  readonly code = "MANAGED_EXACT_PORT_OCCUPIED" as const;
}

export class ManagedStickyPortOccupiedError extends Data.TaggedError(
  "ManagedStickyPortOccupiedError",
)<{
  readonly key: ConfigPortKey;
  readonly port: number;
  readonly stackId: string;
  readonly ownerStackId?: string;
  readonly ownerStackName?: string;
}> {
  readonly code = "MANAGED_STICKY_PORT_OCCUPIED" as const;
}

export class ManagedPortClaimRaceError extends Data.TaggedError("ManagedPortClaimRaceError")<{
  readonly stackId: string;
  readonly port: number;
  readonly ownerStackId: string;
}> {
  readonly code = "MANAGED_PORT_CLAIM_RACE" as const;
}

export class ManagedPortAllocationError extends Data.TaggedError("ManagedPortAllocationError")<{
  readonly fields: ReadonlyArray<PortField>;
  readonly cause: unknown;
}> {
  readonly code = "MANAGED_PORT_ALLOCATION_FAILED" as const;
}

export class ManagedRunningStackPortChangeError extends Data.TaggedError(
  "ManagedRunningStackPortChangeError",
)<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_RUNNING_STACK_PORT_CHANGE" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} cannot change ports while it continues to occupy them`;
  }
}

/**
 * The default `reason` prefix, used by the stack-removal guard that motivated
 * this failure. State-root refusals pass their own `reason`.
 */
const UNSAFE_MANAGED_STACK_PATH_REASON = "Refusing to remove an unsafe managed stack path";

export class UnsafeManagedStackPathError extends Data.TaggedError("UnsafeManagedStackPathError")<{
  readonly path: string;
  /**
   * Names which refusal this is, since the same coded failure guards both
   * stack removal and state roots. Defaults to the stack-removal wording.
   */
  readonly reason?: string;
}> {
  readonly code = "UNSAFE_MANAGED_STACK_PATH" as const;

  /**
   * The refused path is quoted rather than interpolated bare: the values worth
   * refusing include blank and whitespace-only ones, which would otherwise
   * render as an empty message tail.
   */
  override get message(): string {
    return `${this.reason ?? UNSAFE_MANAGED_STACK_PATH_REASON}: ${JSON.stringify(this.path)}`;
  }
}

export class ManagedStackInitializationError extends Data.TaggedError(
  "ManagedStackInitializationError",
)<{
  readonly stackId: string;
  readonly cause: unknown;
  readonly cleanupErrors: ReadonlyArray<unknown>;
}> {
  readonly code = "MANAGED_STACK_INITIALIZATION_FAILED" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} could not be initialized`;
  }
}

export class ManagedStackPublicationTimeoutError extends Data.TaggedError(
  "ManagedStackPublicationTimeoutError",
)<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_STACK_PUBLICATION_TIMEOUT" as const;

  override get message(): string {
    return `Timed out waiting for managed stack ${this.stackId} to be published`;
  }
}

export class ManagedAbandonedOperationError extends Data.TaggedError(
  "ManagedAbandonedOperationError",
)<{
  readonly stackId: string;
}> {
  readonly code = "MANAGED_OPERATION_REQUIRES_RECONCILIATION" as const;

  override get message(): string {
    return `Managed stack ${this.stackId} has an abandoned operation that must be reconciled`;
  }
}

/**
 * Any managed registry failure.
 *
 * Every managed failure is a `Data.TaggedError`, so they cannot share a base
 * class — each one extends its own generated base. The hierarchy is therefore a
 * union type rather than a root class, and {@link isManagedStackError} is the
 * runtime equivalent of the old `instanceof` check.
 */
export type ManagedStackError =
  | ManagedCheckoutConflictError
  | ManagedCopiedBranchConflictError
  | DuplicateManagedIdentityError
  | DuplicateManagedPortKeyError
  | IncompatibleManagedRegistryError
  | InvalidManagedIdentityError
  | InvalidManagedOwnerPidError
  | InvalidManagedPortError
  | InvalidManagedStackNameError
  | ManagedAbandonedOperationError
  | ManagedOperationInProgressError
  | ManagedOperationOwnershipError
  | ManagedIdentityTransitionOwnershipError
  | ManagedInaccessiblePathError
  | ManagedPendingStackUpdateError
  | ManagedExactPortOccupiedError
  | ManagedStickyPortOccupiedError
  | ManagedPortClaimRaceError
  | ManagedPortAllocationError
  | ManagedPortReservationError
  | ManagedRunningStackPortChangeError
  | ManagedStackInitializationError
  | ManagedStackNotFoundError
  | ManagedStackNotStoppedError
  | ManagedStackPublicationTimeoutError
  | UnsafeManagedStackPathError
  | UnsupportedGitWorkspaceError;

/**
 * Every `code` literal declared by a managed failure, and every `_tag`
 * declared alongside it.
 *
 * Both are derived from {@link ManagedStackError} itself — indexing a
 * property on a union type distributes over its members — so adding, removing,
 * or renaming a failure class's `code`/`_tag` changes these unions without any
 * hand-maintained list to fall out of sync. What compile-time indexing cannot
 * catch is two different classes declaring the *same* `code` literal: the
 * union would just collapse to one member, so that particular mistake still
 * needs a runtime guard (or review) rather than the type checker.
 */
export type ManagedErrorCode = ManagedStackError["code"];
export type ManagedErrorTag = ManagedStackError["_tag"];

/**
 * Requires `array` to contain every member of the string-literal union `T`,
 * order and duplicates aside. If `T` has a member missing from the supplied
 * array, `[T] extends [U[number]]` resolves to `never`, which makes the
 * parameter type `never` and turns any array literal into a type error at the
 * call site — so `MANAGED_ERROR_CODES` below cannot silently drop a code.
 */
function exhaustiveArrayOf<T extends string>() {
  return <U extends ReadonlyArray<T>>(array: U & ([T] extends [U[number]] ? unknown : never)): U =>
    array;
}

/**
 * Every `code` literal declared by a managed failure, checked exhaustive
 * against {@link ManagedErrorCode} at compile time by {@link exhaustiveArrayOf}.
 *
 * `code` is the wire-level contract: identifier minification renames the
 * constructors, so a release build's telemetry and any cross-runtime consumer
 * need a value the bundler cannot touch.
 *
 * This module must stay free of runtime-specific imports: it is published as
 * `@supabase/stack/managed-model` precisely so consumers can import the codes
 * under Bun and Node alike, without pulling in a SQLite driver.
 */
export const MANAGED_ERROR_CODES = exhaustiveArrayOf<ManagedErrorCode>()([
  "MANAGED_CHECKOUT_CONFLICT",
  "MANAGED_COPIED_BRANCH_CONFLICT",
  "DUPLICATE_MANAGED_IDENTITY",
  "INVALID_MANAGED_IDENTITY",
  "INCOMPATIBLE_MANAGED_REGISTRY",
  "MANAGED_DUPLICATE_PORT_KEY",
  "MANAGED_INVALID_OWNER_PID",
  "MANAGED_INVALID_PORT",
  "MANAGED_INVALID_STACK_NAME",
  "MANAGED_OPERATION_IN_PROGRESS",
  "MANAGED_OPERATION_OWNERSHIP_MISMATCH",
  "MANAGED_IDENTITY_TRANSITION_OWNERSHIP",
  "MANAGED_INACCESSIBLE_PATH",
  "MANAGED_OPERATION_REQUIRES_RECONCILIATION",
  "MANAGED_PENDING_STACK_UPDATE",
  "MANAGED_EXACT_PORT_OCCUPIED",
  "MANAGED_STICKY_PORT_OCCUPIED",
  "MANAGED_PORT_CLAIM_RACE",
  "MANAGED_PORT_ALLOCATION_FAILED",
  "MANAGED_PORT_ALREADY_RESERVED",
  "MANAGED_RUNNING_STACK_PORT_CHANGE",
  "MANAGED_STACK_INITIALIZATION_FAILED",
  "MANAGED_STACK_NOT_FOUND",
  "MANAGED_STACK_NOT_STOPPED",
  "MANAGED_STACK_PUBLICATION_TIMEOUT",
  "UNSAFE_MANAGED_STACK_PATH",
  "UNSUPPORTED_GIT_WORKSPACE",
] as const);

/**
 * The single source of truth linking each managed `code` to the `_tag` of the
 * class that declares it.
 *
 * `_tag` is the Effect-native discriminant (`Effect.catchTag`, structural
 * dispatch) and `code` is the stable wire-level contract. Consumers that key a
 * table by one and dispatch on the other — the CLI's telemetry classifier is
 * the motivating case — derive it from this map instead of restating every pair
 * by hand. Typing this `satisfies Record<ManagedErrorCode,
 * ManagedErrorTag>` requires every code to be present with a valid tag, so a
 * new error class that is not registered here is a compile error.
 */
export const MANAGED_ERROR_TAG_BY_CODE = {
  MANAGED_CHECKOUT_CONFLICT: "ManagedCheckoutConflictError",
  MANAGED_COPIED_BRANCH_CONFLICT: "ManagedCopiedBranchConflictError",
  DUPLICATE_MANAGED_IDENTITY: "DuplicateManagedIdentityError",
  INVALID_MANAGED_IDENTITY: "InvalidManagedIdentityError",
  INCOMPATIBLE_MANAGED_REGISTRY: "IncompatibleManagedRegistryError",
  MANAGED_DUPLICATE_PORT_KEY: "DuplicateManagedPortKeyError",
  MANAGED_INVALID_OWNER_PID: "InvalidManagedOwnerPidError",
  MANAGED_INVALID_PORT: "InvalidManagedPortError",
  MANAGED_INVALID_STACK_NAME: "InvalidManagedStackNameError",
  MANAGED_OPERATION_IN_PROGRESS: "ManagedOperationInProgressError",
  MANAGED_OPERATION_OWNERSHIP_MISMATCH: "ManagedOperationOwnershipError",
  MANAGED_IDENTITY_TRANSITION_OWNERSHIP: "ManagedIdentityTransitionOwnershipError",
  MANAGED_INACCESSIBLE_PATH: "ManagedInaccessiblePathError",
  MANAGED_OPERATION_REQUIRES_RECONCILIATION: "ManagedAbandonedOperationError",
  MANAGED_PENDING_STACK_UPDATE: "ManagedPendingStackUpdateError",
  MANAGED_EXACT_PORT_OCCUPIED: "ManagedExactPortOccupiedError",
  MANAGED_STICKY_PORT_OCCUPIED: "ManagedStickyPortOccupiedError",
  MANAGED_PORT_CLAIM_RACE: "ManagedPortClaimRaceError",
  MANAGED_PORT_ALLOCATION_FAILED: "ManagedPortAllocationError",
  MANAGED_PORT_ALREADY_RESERVED: "ManagedPortReservationError",
  MANAGED_RUNNING_STACK_PORT_CHANGE: "ManagedRunningStackPortChangeError",
  MANAGED_STACK_INITIALIZATION_FAILED: "ManagedStackInitializationError",
  MANAGED_STACK_NOT_FOUND: "ManagedStackNotFoundError",
  MANAGED_STACK_NOT_STOPPED: "ManagedStackNotStoppedError",
  MANAGED_STACK_PUBLICATION_TIMEOUT: "ManagedStackPublicationTimeoutError",
  UNSAFE_MANAGED_STACK_PATH: "UnsafeManagedStackPathError",
  UNSUPPORTED_GIT_WORKSPACE: "UnsupportedGitWorkspaceError",
} as const satisfies Record<ManagedErrorCode, ManagedErrorTag>;

const MANAGED_ERROR_TAGS: ReadonlySet<string> = new Set(Object.values(MANAGED_ERROR_TAG_BY_CODE));

/**
 * Whether a value is a managed registry failure. Replaces the `instanceof`
 * check against the removed `ManagedStackError` root class: the union's members
 * each extend their own `Data.TaggedError` base, so the shared discriminator is
 * the tag rather than a prototype chain.
 */
export function isManagedStackError(error: unknown): error is ManagedStackError {
  if (!(error instanceof Error) || !("_tag" in error)) return false;
  const tag: unknown = error._tag;
  return typeof tag === "string" && MANAGED_ERROR_TAGS.has(tag);
}
