import type { ServiceName } from "./ServiceName.ts";
import type { ResolvedStackConfig } from "./StackConfig.ts";

/**
 * What tells one running stack's Docker resources apart from every other one's.
 *
 * A stack that was given an identity is keyed by a namespaced form of it; one
 * that was not falls back to its api port, which is what names were always
 * built from. The fallback is what keeps the direct ephemeral API unchanged,
 * and the identity is what stops two stacks that happen to share a port — a
 * crashed one's leftovers and the sibling that reused its port — from
 * colliding on the same container names.
 */
export interface StackIdentity {
  /** What container names are built from, in a disjoint namespace per identity kind. */
  readonly key: string;
  /** The identity the stack was given, when it was given one. */
  readonly stackId: string | undefined;
}

/**
 * The Docker label every container of an identified stack carries, so its
 * containers can be found by identity even when their names change.
 */
export const STACK_ID_LABEL = "com.supabase.stack-id";

const EXPLICIT_IDENTITY_PREFIX = "id-";

/** The one place a stack's identity is derived from its config. */
export const stackIdentity = (
  config: Pick<ResolvedStackConfig, "instanceId" | "apiPort">,
): StackIdentity => ({
  key:
    config.instanceId === undefined
      ? String(config.apiPort)
      : `${EXPLICIT_IDENTITY_PREFIX}${config.instanceId}`,
  stackId: config.instanceId,
});

export const dockerContainerName = (service: ServiceName, instanceKey: string): string =>
  `supabase-${service}-${instanceKey}`;
