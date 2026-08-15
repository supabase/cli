import type { GitCheckoutInspection } from "./git.ts";
import type {
  ManagedCheckoutKind,
  ManagedContextKind,
  ManagedIdentityTransitionRecord,
} from "./model.ts";

export const NEW_CHECKOUT_ORDINARY_TOPOLOGY = "topology:ordinary";
export const NEW_CHECKOUT_DETACHED_TOPOLOGY = "topology:detached";

export const checkoutKindOf = (inspection: GitCheckoutInspection): ManagedCheckoutKind =>
  inspection.checkoutKind === "primary" ? "git" : inspection.checkoutKind;

export const newCheckoutTopologyMatches = (
  transition: ManagedIdentityTransitionRecord,
  context: { readonly kind: ManagedContextKind; readonly branch?: string },
): boolean => {
  if (context.kind === "branch") return transition.branch === context.branch;
  return (
    transition.branch === undefined &&
    transition.expectedGitValue ===
      (context.kind === "workspace"
        ? NEW_CHECKOUT_ORDINARY_TOPOLOGY
        : NEW_CHECKOUT_DETACHED_TOPOLOGY)
  );
};
