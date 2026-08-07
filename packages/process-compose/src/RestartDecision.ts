import type { RestartPolicy } from "./ServiceDef.ts";
import type { ServiceDesiredState } from "./ServiceState.ts";

export type LifecycleCause =
  | { readonly _tag: "ProcessExit"; readonly exitCode: number }
  | { readonly _tag: "Unhealthy" };

export type RestartDecision =
  | { readonly _tag: "Restart"; readonly restartCount: number }
  | {
      readonly _tag: "Terminate";
      readonly reason: "NotDesired" | "PolicyDisabled" | "BudgetExhausted";
    }
  | { readonly _tag: "KeepRunningUnhealthy" };

export const UNHEALTHY_RESTART_EXHAUSTED_ERROR =
  "Health check failed and restart budget was exhausted";

export function decideRestart(options: {
  readonly cause: LifecycleCause;
  readonly policy: RestartPolicy;
  readonly restartCount: number;
  readonly maxRestarts: number;
  readonly desired: ServiceDesiredState;
}): RestartDecision {
  if (options.desired !== "running") {
    return { _tag: "Terminate", reason: "NotDesired" };
  }

  if (options.cause._tag === "Unhealthy" && options.policy === "no") {
    return { _tag: "KeepRunningUnhealthy" };
  }

  const policyAllowsRestart =
    options.policy === "always" ||
    options.policy === "unless-stopped" ||
    (options.policy === "on-failure" &&
      (options.cause._tag === "Unhealthy" || options.cause.exitCode !== 0));

  if (!policyAllowsRestart) {
    return { _tag: "Terminate", reason: "PolicyDisabled" };
  }

  if (options.maxRestarts !== 0 && options.restartCount >= options.maxRestarts) {
    return { _tag: "Terminate", reason: "BudgetExhausted" };
  }

  return { _tag: "Restart", restartCount: options.restartCount + 1 };
}
