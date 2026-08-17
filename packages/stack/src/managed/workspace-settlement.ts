import type { ManagedWorkspaceDiscovery } from "./discovery.ts";

export const sameManagedWorkspaceTopology = (
  before: ManagedWorkspaceDiscovery,
  after: ManagedWorkspaceDiscovery,
): boolean =>
  before.workspace.checkoutKind === after.workspace.checkoutKind &&
  before.workspace.workspaceRoot === after.workspace.workspaceRoot &&
  before.workspace.projectIdentityLocation === after.workspace.projectIdentityLocation &&
  before.workspace.checkoutIdentityLocation === after.workspace.checkoutIdentityLocation &&
  before.context.kind === after.context.kind &&
  before.context.branch === after.context.branch &&
  before.context.commit === after.context.commit;

export const identityPublicationIsMonotonic = (
  before: ManagedWorkspaceDiscovery,
  after: ManagedWorkspaceDiscovery,
): boolean =>
  (before.identity.projectId === undefined ||
    before.identity.projectId === after.identity.projectId) &&
  (before.identity.checkoutId === undefined ||
    before.identity.checkoutId === after.identity.checkoutId) &&
  (before.identity.contextId === undefined ||
    before.identity.contextId === after.identity.contextId);

const identityPublicationAdvanced = (
  before: ManagedWorkspaceDiscovery,
  after: ManagedWorkspaceDiscovery,
): boolean =>
  (before.identity.projectId === undefined && after.identity.projectId !== undefined) ||
  (before.identity.checkoutId === undefined && after.identity.checkoutId !== undefined) ||
  (before.identity.contextId === undefined && after.identity.contextId !== undefined);

/** A same-topology start may have published part of the Git identity meanwhile. */
export const concurrentIdentityPublication = (
  before: ManagedWorkspaceDiscovery,
  after: ManagedWorkspaceDiscovery,
): boolean =>
  before.state === "unregistered" &&
  after.state === "unregistered" &&
  after.conflicts.length === 0 &&
  after.activeTransition === undefined &&
  sameManagedWorkspaceTopology(before, after) &&
  identityPublicationIsMonotonic(before, after) &&
  identityPublicationAdvanced(before, after);

export const benignConcurrentRegistration = (
  before: ManagedWorkspaceDiscovery,
  after: ManagedWorkspaceDiscovery,
): boolean => {
  const identityComplete =
    after.identity.projectId !== undefined &&
    after.identity.checkoutId !== undefined &&
    after.identity.contextId !== undefined;
  const newCheckoutReserved =
    before.state === "unregistered" &&
    after.state === "transitioning" &&
    after.activeTransition?.kind === "new-checkout" &&
    after.activeTransition.path === after.workspace.workspaceRoot &&
    after.activeTransition.projectIdentityLocation === after.workspace.projectIdentityLocation &&
    after.conflicts.length === 0;

  return (
    before.state === "unregistered" &&
    sameManagedWorkspaceTopology(before, after) &&
    identityPublicationIsMonotonic(before, after) &&
    ((after.activeTransition === undefined &&
      ((after.state === "healthy" && identityComplete && after.conflicts.length === 0) ||
        concurrentIdentityPublication(before, after))) ||
      newCheckoutReserved)
  );
};
