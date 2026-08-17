import type { ManagedCheckoutKind, ManagedContextDescriptor, ManagedContextKind } from "./model.ts";
import type { WorkspaceInspection } from "./git.ts";
import { ordinaryWorkspaceIdentityPath } from "./paths.ts";
import { checkoutKindOf } from "./topology.ts";

export interface ManagedWorkspaceDiscoveryWorkspace {
  readonly checkoutKind: ManagedCheckoutKind;
  readonly canonicalPath: string;
  readonly workspaceRoot: string;
  readonly projectIdentityLocation: string;
  readonly checkoutIdentityLocation: string;
}

export interface ManagedWorkspaceDiscoveryContext {
  readonly kind: ManagedContextKind;
  readonly branch?: string;
  readonly commit?: string;
}

export interface ManagedWorkspaceMetadata {
  readonly workspace: ManagedWorkspaceDiscoveryWorkspace;
  readonly context: ManagedWorkspaceDiscoveryContext;
  readonly contextDescriptor: ManagedContextDescriptor;
}

export const workspaceMetadata = (inspection: WorkspaceInspection): ManagedWorkspaceMetadata => {
  if (inspection.kind === "ordinary-folder") {
    const markerPath = ordinaryWorkspaceIdentityPath(inspection.canonicalPath);
    return {
      workspace: {
        checkoutKind: "ordinary",
        canonicalPath: inspection.canonicalPath,
        workspaceRoot: inspection.canonicalPath,
        projectIdentityLocation: markerPath,
        checkoutIdentityLocation: markerPath,
      },
      context: { kind: "workspace" },
      contextDescriptor: { kind: "workspace" },
    };
  }
  return {
    workspace: {
      checkoutKind: checkoutKindOf(inspection),
      canonicalPath: inspection.canonicalPath,
      workspaceRoot: inspection.workspaceRoot,
      projectIdentityLocation: inspection.commonDirectory,
      checkoutIdentityLocation: inspection.gitDirectory,
    },
    context:
      inspection.head.kind === "detached"
        ? { kind: "detached", commit: inspection.head.commit }
        : { kind: "branch", branch: inspection.head.branch },
    contextDescriptor:
      inspection.head.kind === "detached"
        ? { kind: "detached" }
        : { kind: "branch", locator: inspection.head.branch },
  };
};
