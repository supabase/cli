import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { Effect, FileSystem } from "effect";
import {
  canonicalizeManagedWorkspacePathWithFileSystem,
  ensureDetachedContextIdentity,
  ensureGitCheckoutLocation,
  ensureOrdinaryWorkspaceIdentity,
  readDetachedContextIdentity,
  readGitCheckoutLocation,
  readOrdinaryWorkspaceIdentityWithFileSystem,
} from "./identity.ts";
import {
  ensureBranchContextId,
  ensureGitCheckoutIdentity,
  GitConfigStore,
  inspectWorkspace,
  readBranchContextId,
  readGitCheckoutIdentityWithFileSystem,
  type WorkspaceInspection,
} from "./git.ts";
import { InvalidManagedIdentityError, UnsupportedGitWorkspaceError } from "./model.ts";

export interface EnvironmentIdentity {
  readonly workspaceId: string;
  readonly checkoutId: string;
  readonly contextId: string;
  readonly localProjectKey: string;
}

export type RepairReason = "moved" | "duplicate";

export interface WorkspaceDescriptor {
  readonly kind: "git" | "folder";
  readonly checkoutKind: "primary" | "worktree" | "bare" | "folder";
  /** Canonical Supabase project root used to initiate discovery. */
  readonly path: string;
  readonly branch?: string;
}

export interface RepairUpdate {
  readonly kind: "checkout-location";
  readonly from: string;
  readonly to: string;
}

export interface RepairRequest {
  readonly reason: RepairReason;
  readonly path: string;
  readonly expectedPath: string;
  readonly identity: EnvironmentIdentity;
  readonly updates: ReadonlyArray<RepairUpdate>;
}

interface WorkspaceDiscoveryBase {
  readonly path: string;
  readonly workspace: WorkspaceDescriptor;
  /** The complete identity, including deterministic values for all workspace claims. */
  readonly identity: EnvironmentIdentity;
}

type PartialEnvironmentIdentity = {
  workspaceId?: string;
  checkoutId?: string;
  contextId?: string;
};

export interface ReadyWorkspaceDiscovery extends WorkspaceDiscoveryBase {
  readonly state: "ready";
}

export interface RepairWorkspaceDiscovery extends WorkspaceDiscoveryBase {
  readonly state: "needsRepair";
  readonly reason: RepairReason;
  readonly repair: RepairRequest;
}

export type WorkspaceDiscovery = ReadyWorkspaceDiscovery | RepairWorkspaceDiscovery;

type EnvironmentError = InvalidManagedIdentityError | UnsupportedGitWorkspaceError;

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const deterministicUuid = (seed: string): string => {
  const hex = digest(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(
    8 +
    (Number.parseInt(hex.slice(16, 17), 16) % 4)
  ).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const identityFactory = (seed: string): (() => string) => {
  let temporary = 0;
  return () => deterministicUuid(`${seed}:${temporary++}`);
};

const lengthPrefixed = (value: string): Buffer => {
  const bytes = Buffer.from(value, "utf8");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(bytes.byteLength, 0);
  return Buffer.concat([prefix, bytes]);
};

/** Derive the stack identity from five UTF-8 length-prefixed values. */
export const deriveStackId = (identity: EnvironmentIdentity, name: string): string =>
  createHash("sha256")
    .update(
      Buffer.concat([
        lengthPrefixed(identity.workspaceId),
        lengthPrefixed(identity.checkoutId),
        lengthPrefixed(identity.contextId),
        lengthPrefixed(identity.localProjectKey),
        lengthPrefixed(name),
      ]),
    )
    .digest("hex");

const descriptor = (inspection: WorkspaceInspection): WorkspaceDescriptor => {
  if (inspection.kind === "ordinary-folder") {
    return { kind: "folder", checkoutKind: "folder", path: inspection.canonicalPath };
  }
  return {
    kind: "git",
    checkoutKind:
      inspection.checkoutKind === "primary"
        ? "primary"
        : inspection.checkoutKind === "bare-worktree"
          ? "bare"
          : "worktree",
    path: inspection.canonicalPath,
    ...(inspection.head.kind === "detached" ? {} : { branch: inspection.head.branch }),
  };
};

const partialIdentity = (
  inspection: WorkspaceInspection,
  values: PartialEnvironmentIdentity,
  localProjectKey: string,
): EnvironmentIdentity => {
  if (inspection.kind === "ordinary-folder") {
    const seed = `folder:${inspection.canonicalPath}`;
    return {
      workspaceId: values.workspaceId ?? deterministicUuid(`${seed}:workspaceId`),
      checkoutId: values.checkoutId ?? deterministicUuid(`${seed}:checkoutId`),
      contextId: values.contextId ?? deterministicUuid(`${seed}:contextId`),
      localProjectKey,
    };
  }
  return {
    workspaceId:
      values.workspaceId ?? deterministicUuid(`git:workspace:${inspection.commonDirectory}`),
    checkoutId: values.checkoutId ?? deterministicUuid(`git:checkout:${inspection.gitDirectory}`),
    contextId:
      values.contextId ??
      deterministicUuid(
        inspection.head.kind === "detached"
          ? `git:detached:${inspection.gitDirectory}`
          : `git:branch:${inspection.commonDirectory}:${inspection.head.branch}`,
      ),
    localProjectKey,
  };
};

const localProjectKeyFor = (
  inspection: WorkspaceInspection,
  canonicalPath: string,
): Effect.Effect<string, InvalidManagedIdentityError> => {
  if (inspection.kind === "ordinary-folder") return Effect.succeed(".");
  const key = relative(inspection.workspaceRoot, canonicalPath).split(sep).join("/");
  if (isAbsolute(key) || key === ".." || key.startsWith("../")) {
    return Effect.fail(
      new InvalidManagedIdentityError({
        message: `Supabase project path escapes its Git checkout: ${canonicalPath}`,
      }),
    );
  }
  return Effect.succeed(key.length === 0 ? "." : key);
};

const makeRepairDiscovery = (
  path: string,
  workspace: WorkspaceDescriptor,
  identity: EnvironmentIdentity,
  reason: RepairReason,
  repair: RepairRequest,
): RepairWorkspaceDiscovery => ({
  state: "needsRepair",
  reason,
  repair,
  path,
  workspace,
  identity,
});

const makeRegistrationDiscovery = (
  path: string,
  workspace: WorkspaceDescriptor,
  identity: EnvironmentIdentity,
): ReadyWorkspaceDiscovery => ({ state: "ready", path, workspace, identity });

const discoverInternal = (
  workspacePath: string,
): Effect.Effect<WorkspaceDiscovery, EnvironmentError, FileSystem.FileSystem | GitConfigStore> =>
  Effect.gen(function* () {
    const canonicalPath = yield* canonicalizeManagedWorkspacePathWithFileSystem(workspacePath);
    const inspection = yield* inspectWorkspace(canonicalPath);
    const localProjectKey = yield* localProjectKeyFor(inspection, canonicalPath);
    const values: PartialEnvironmentIdentity = {};
    let location: string | undefined;
    if (inspection.kind === "ordinary-folder") {
      const marker = yield* readOrdinaryWorkspaceIdentityWithFileSystem(canonicalPath);
      if (marker !== undefined) {
        values.workspaceId = marker.workspaceId;
        values.checkoutId = marker.checkoutId;
        values.contextId = marker.contextId;
      }
    } else {
      const stored = yield* readGitCheckoutIdentityWithFileSystem(inspection);
      values.workspaceId = stored.workspaceId;
      values.checkoutId = stored.checkoutId;
      if (inspection.head.kind === "detached") {
        values.contextId = yield* readDetachedContextIdentity(inspection.gitDirectory);
      } else {
        values.contextId = yield* readBranchContextId(inspection, inspection.head.branch);
      }
      location = yield* readGitCheckoutLocation(inspection.gitDirectory);
    }
    const identity = partialIdentity(inspection, values, localProjectKey);
    const workspace = descriptor(inspection);
    if (
      inspection.kind === "git-checkout" &&
      location !== undefined &&
      location !== inspection.workspaceRoot
    ) {
      const fs = yield* FileSystem.FileSystem;
      const duplicate = yield* fs.exists(location).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new UnsupportedGitWorkspaceError({
              path: location,
              reason: `Checkout location is inaccessible (${error.message})`,
              workspaceCause: "metadata-inaccessible",
            }),
          ),
        ),
      );
      const reason: RepairReason = duplicate ? "duplicate" : "moved";
      const repair: RepairRequest = {
        reason,
        path: inspection.workspaceRoot,
        expectedPath: location,
        identity,
        updates: [{ kind: "checkout-location", from: location, to: inspection.workspaceRoot }],
      };
      return makeRepairDiscovery(canonicalPath, workspace, identity, reason, repair);
    }
    return makeRegistrationDiscovery(canonicalPath, workspace, identity);
  });

export const discoverEnvironment = (workspacePath: string) => discoverInternal(workspacePath);

export const ensureEnvironment = (
  workspacePath: string,
): Effect.Effect<WorkspaceDiscovery, EnvironmentError, FileSystem.FileSystem | GitConfigStore> =>
  Effect.gen(function* () {
    const before = yield* discoverInternal(workspacePath);
    if (before.state === "needsRepair") return before;
    const inspection = yield* inspectWorkspace(before.path);
    if (inspection.kind === "ordinary-folder") {
      const seed = `folder:${inspection.canonicalPath}`;
      const factory = identityFactory(seed);
      yield* ensureOrdinaryWorkspaceIdentity(inspection.canonicalPath, factory);
    } else {
      const seed = `git:${inspection.commonDirectory}:${inspection.gitDirectory}`;
      const factory = identityFactory(seed);
      yield* ensureGitCheckoutIdentity(inspection, factory);
      if (inspection.head.kind === "detached") {
        yield* ensureDetachedContextIdentity(inspection.gitDirectory, factory);
      } else {
        yield* ensureBranchContextId(inspection, inspection.head.branch, factory);
      }
      yield* ensureGitCheckoutLocation(inspection.gitDirectory, inspection.workspaceRoot);
    }
    return yield* discoverInternal(before.path);
  });

export const validateEnvironmentRepair = (
  request: RepairRequest,
): Effect.Effect<RepairRequest, EnvironmentError, FileSystem.FileSystem | GitConfigStore> =>
  Effect.gen(function* () {
    const current = yield* discoverInternal(request.path);
    if (request.reason === "duplicate") {
      return yield* Effect.fail(
        new InvalidManagedIdentityError({
          message: "Duplicate checkout evidence requires an explicit ownership decision",
        }),
      );
    }
    const currentUpdates = current.state === "needsRepair" ? current.repair.updates : [];
    const requestedUpdates = request.updates;
    const currentUpdate = currentUpdates[0];
    const requestedUpdate = requestedUpdates[0];
    const updatesMatch =
      currentUpdates.length === 1 &&
      requestedUpdates.length === 1 &&
      currentUpdate !== undefined &&
      requestedUpdate !== undefined &&
      requestedUpdate.kind === currentUpdate.kind &&
      requestedUpdate.from === currentUpdate.from &&
      requestedUpdate.to === currentUpdate.to;
    if (
      current.state !== "needsRepair" ||
      current.reason !== request.reason ||
      current.repair.path !== request.path ||
      current.repair.expectedPath !== request.expectedPath ||
      current.identity.workspaceId !== request.identity.workspaceId ||
      current.identity.checkoutId !== request.identity.checkoutId ||
      current.identity.contextId !== request.identity.contextId ||
      !updatesMatch
    ) {
      return yield* Effect.fail(
        new InvalidManagedIdentityError({ message: "Workspace identity changed before repair" }),
      );
    }
    return current.repair;
  });
