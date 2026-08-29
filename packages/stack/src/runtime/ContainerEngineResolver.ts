import { Context, Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { ContainerEngineFailure, ContainerEngineKind } from "./ContainerEngine.ts";

/**
 * Host-composition seam for selecting one concrete container engine. The
 * service is intentionally narrow so createStack can be tested without a
 * local daemon while production uses the real Docker/Podman adapters.
 */
export interface ContainerEngineResolverShape {
  readonly resolve: (
    preference: "auto" | ContainerEngineKind,
  ) => Effect.Effect<ContainerEngineKind, ContainerEngineFailure, ChildProcessSpawner>;
}

export class ContainerEngineResolver extends Context.Service<
  ContainerEngineResolver,
  ContainerEngineResolverShape
>()("@supabase/stack/ContainerEngineResolver") {}
